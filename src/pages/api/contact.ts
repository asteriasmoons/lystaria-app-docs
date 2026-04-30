import type { APIRoute } from "astro";
import nodemailer from "nodemailer";

function requireEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function isEmail(s: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

async function verifyEmailWithAbstract(email: string, apiKey: string) {
  const url = new URL("https://emailreputation.abstractapi.com/v1/");
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("email", email);

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: { Accept: "application/json" },
  });

  const data = await res.json().catch(() => null);

  if (!res.ok) {
    const message =
      data && typeof data.error === "string"
        ? data.error
        : "Email verification failed.";
    throw new Error(`Abstract error (${res.status}): ${message}`);
  }

  return data;
}

const hits = new Map<string, { count: number; resetAt: number }>();

function rateLimit(ip: string) {
  const now = Date.now();
  const windowMs = 60_000;
  const max = 5;

  const existing = hits.get(ip);
  if (!existing || existing.resetAt < now) {
    hits.set(ip, { count: 1, resetAt: now + windowMs });
    return { ok: true };
  }

  if (existing.count >= max) return { ok: false };

  existing.count += 1;
  hits.set(ip, existing);
  return { ok: true };
}

export const POST: APIRoute = async ({ request, clientAddress }) => {
  try {
    const ip = clientAddress || "unknown";
    const rl = rateLimit(ip);
    if (!rl.ok) {
      return new Response(
        JSON.stringify({ error: "Too many requests. Try again in a minute." }),
        { status: 429, headers: { "Content-Type": "application/json" } }
      );
    }

    const body = await request.json().catch(() => null);
    if (!body) {
      return new Response(JSON.stringify({ error: "Invalid JSON." }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim();
    const message = String(body.message || "").trim();
    const website = String(body.website || "").trim();

    // Honeypot
    if (website) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (!name || !email || !message) {
      return new Response(
        JSON.stringify({ error: "Name, email, and message are required." }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    if (!isEmail(email)) {
      return new Response(
        JSON.stringify({ error: "Please enter a valid email address." }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const ABSTRACT_API_KEY = requireEnv("ABSTRACT_API_KEY");
    const verification = await verifyEmailWithAbstract(email, ABSTRACT_API_KEY);

    const isValidFormat = verification?.email_deliverability?.is_format_valid;
    const isDisposable = verification?.email_quality?.is_disposable;
    const deliverability = String(
      verification?.email_deliverability?.status || ""
    ).toLowerCase();

    if (isDisposable) {
      return new Response(
        JSON.stringify({ error: "Disposable email addresses are not allowed." }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    if (!isValidFormat) {
      return new Response(
        JSON.stringify({ error: "Please enter a valid email address." }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    if (deliverability === "undeliverable") {
      return new Response(
        JSON.stringify({ error: "That email address could not be verified." }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const SMTP_HOST = requireEnv("SMTP_HOST");
    const SMTP_PORT = Number(requireEnv("SMTP_PORT"));
    const SMTP_USER = requireEnv("SMTP_USER");
    const SMTP_PASS = requireEnv("SMTP_PASS");
    const CONTACT_TO = requireEnv("CONTACT_TO");
    const CONTACT_FROM = requireEnv("CONTACT_FROM");

    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });

    await transporter.verify();

    await transporter.sendMail({
      from: CONTACT_FROM,
      to: CONTACT_TO,
      replyTo: email,
      subject: `Lystaria Docs Contact: ${name}`,
      text:
        `New message from Lystaria Docs\n\n` +
        `Name: ${name}\n` +
        `Email: ${email}\n\n` +
        `Message:\n${message}\n`,
    });

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err: any) {
    console.error("contact api error:", err?.message || err);
    return new Response(JSON.stringify({ error: "Failed to send message." }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};
