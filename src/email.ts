import nodemailer, { type Transporter } from "nodemailer";

let transporter: Transporter | null = null;

function getTransporter(): Transporter | null {
  if (transporter) return transporter;

  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASSWORD) return null;

  const port = Number(SMTP_PORT ?? 587);
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASSWORD },
  });
  return transporter;
}

export async function sendAccessEmail(
  to: string,
  accessUrl: string,
): Promise<void> {
  const transport = getTransporter();
  if (!transport) {
    // Without SMTP configured the buyer has paid and would otherwise get
    // nothing, so make the link recoverable from the server logs.
    console.warn(
      `[email] SMTP not configured. Access link for ${to}: ${accessUrl}`,
    );
    return;
  }

  await transport.sendMail({
    from: process.env.MAIL_FROM ?? "FEPA LLC <no-reply@fepa.example>",
    to,
    subject: "Your EIN-trepreneur AI access link",
    text: [
      "Thanks for your purchase.",
      "",
      "Open this link to unlock EIN-trepreneur AI on your device:",
      accessUrl,
      "",
      "Keep it somewhere safe — it is your access key, and anyone with the",
      "link can use your access. You can reopen it on any device.",
      "",
      "— FEPA LLC",
    ].join("\n"),
  });
}
