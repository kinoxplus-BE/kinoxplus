import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface SendMailOptions {
  to: string;
  subject: string;
  html: string;
}

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly apiKey?: string;
  private readonly senderEmail: string;
  private readonly senderName: string;
  private readonly appName = 'KinoX+';

  constructor(private readonly config: ConfigService) {
    this.apiKey = config.get<string>('BREVO_API_KEY');
    this.senderEmail =
      config.get<string>('BREVO_SENDER_EMAIL') || 'noreply@kinoxplus.com';
    this.senderName = config.get<string>('BREVO_SENDER_NAME') || 'KinoX+';

    if (!this.apiKey) {
      this.logger.warn('BREVO_API_KEY not set — emails will be logged only.');
    }
  }

  async send(options: SendMailOptions): Promise<void> {
    if (!this.apiKey) {
      this.logger.log(
        `[DEV] Email to ${options.to}: ${options.subject} (not sent — no API key)`,
      );
      return;
    }

    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': this.apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        sender: { name: this.senderName, email: this.senderEmail },
        to: [{ email: options.to }],
        subject: options.subject,
        htmlContent: options.html,
      }),
      // A hung Brevo connection must never hold a worker indefinitely.
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      const body = await response.text();
      this.logger.error(`Brevo API error (${response.status}): ${body}`);
      throw new Error(`Failed to send email: ${response.status}`);
    }
  }

  async sendWelcome(to: string, displayName: string): Promise<void> {
    await this.send({
      to,
      subject: `Welcome to ${this.appName}! 🎬`,
      html: this.welcomeTemplate(displayName),
    });
  }

  async sendVerificationOtp(to: string, code: string): Promise<void> {
    await this.send({
      to,
      subject: `Your ${this.appName} verification code`,
      html: this.verificationTemplate(code),
    });
  }

  async sendPasswordResetOtp(to: string, code: string): Promise<void> {
    await this.send({
      to,
      subject: `Reset your ${this.appName} password`,
      html: this.resetTemplate(code),
    });
  }

  async sendLoginOtp(to: string, code: string): Promise<void> {
    await this.send({
      to,
      subject: `Your ${this.appName} login code`,
      html: this.loginOtpTemplate(code),
    });
  }

  async sendPasswordChanged(to: string): Promise<void> {
    await this.send({
      to,
      subject: `Your ${this.appName} password was changed`,
      html: this.passwordChangedTemplate(),
    });
  }

  private baseLayout(content: string): string {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background-color:#f4f4f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f7;">
    <tr>
      <td align="center" style="padding:40px 20px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.06);">
          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#6366f1 0%,#8b5cf6 100%);padding:32px 40px;text-align:center;">
              <h1 style="margin:0;color:#ffffff;font-size:28px;font-weight:700;letter-spacing:-0.5px;">${this.appName}</h1>
              <p style="margin:4px 0 0;color:rgba(255,255,255,0.8);font-size:14px;">Watch together, in perfect sync</p>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:40px;">
              ${content}
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding:24px 40px;background-color:#f9fafb;border-top:1px solid #e5e7eb;">
              <p style="margin:0;color:#9ca3af;font-size:12px;text-align:center;line-height:1.6;">
                This email was sent by ${this.appName}. If you didn't request this, you can safely ignore it.
              </p>
              <p style="margin:8px 0 0;color:#9ca3af;font-size:12px;text-align:center;">
                &copy; ${new Date().getFullYear()} ${this.appName}. All rights reserved.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
  }

  private welcomeTemplate(displayName: string): string {
    return this.baseLayout(`
      <h2 style="margin:0 0 16px;color:#111827;font-size:22px;font-weight:600;">Welcome aboard, ${displayName}!</h2>
      <p style="margin:0 0 24px;color:#4b5563;font-size:16px;line-height:1.6;">
        You've just joined the future of watching together. ${this.appName} lets you watch movies and shows in perfect sync with your friends &mdash; with voice chat, text chat, and shared playback controls.
      </p>
      <h3 style="margin:0 0 12px;color:#111827;font-size:16px;font-weight:600;">Here's what you can do next:</h3>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
        <tr>
          <td style="padding:8px 0;color:#4b5563;font-size:15px;">
            <span style="display:inline-block;width:28px;height:28px;background-color:#ede9fe;color:#7c3aed;border-radius:50%;text-align:center;line-height:28px;font-weight:600;margin-right:12px;">1</span>
            Browse the catalog and find something to watch
          </td>
        </tr>
        <tr>
          <td style="padding:8px 0;color:#4b5563;font-size:15px;">
            <span style="display:inline-block;width:28px;height:28px;background-color:#ede9fe;color:#7c3aed;border-radius:50%;text-align:center;line-height:28px;font-weight:600;margin-right:12px;">2</span>
            Create a Watch Room and invite your friends
          </td>
        </tr>
        <tr>
          <td style="padding:8px 0;color:#4b5563;font-size:15px;">
            <span style="display:inline-block;width:28px;height:28px;background-color:#ede9fe;color:#7c3aed;border-radius:50%;text-align:center;line-height:28px;font-weight:600;margin-right:12px;">3</span>
            Watch together in perfect sync with voice chat
          </td>
        </tr>
      </table>
      <p style="margin:0;color:#6b7280;font-size:14px;">
        Need help? Just reply to this email &mdash; we're happy to assist.
      </p>
    `);
  }

  private verificationTemplate(code: string): string {
    return this.baseLayout(`
      <h2 style="margin:0 0 16px;color:#111827;font-size:22px;font-weight:600;">Verify your email</h2>
      <p style="margin:0 0 24px;color:#4b5563;font-size:16px;line-height:1.6;">
        Use the code below to verify your email address. This code expires in <strong>10 minutes</strong>.
      </p>
      <div style="background-color:#f3f4f6;border:2px dashed #d1d5db;border-radius:12px;padding:24px;text-align:center;margin:0 0 24px;">
        <span style="font-size:36px;font-weight:700;letter-spacing:8px;color:#111827;font-family:'Courier New',monospace;">${code}</span>
      </div>
      <p style="margin:0;color:#6b7280;font-size:14px;line-height:1.6;">
        If you didn't request this code, please ignore this email. Your account is safe.
      </p>
    `);
  }

  private resetTemplate(code: string): string {
    return this.baseLayout(`
      <h2 style="margin:0 0 16px;color:#111827;font-size:22px;font-weight:600;">Reset your password</h2>
      <p style="margin:0 0 24px;color:#4b5563;font-size:16px;line-height:1.6;">
        We received a request to reset your password. Use the code below to proceed. This code expires in <strong>10 minutes</strong>.
      </p>
      <div style="background-color:#fef2f2;border:2px dashed #fca5a5;border-radius:12px;padding:24px;text-align:center;margin:0 0 24px;">
        <span style="font-size:36px;font-weight:700;letter-spacing:8px;color:#991b1b;font-family:'Courier New',monospace;">${code}</span>
      </div>
      <p style="margin:0 0 16px;color:#4b5563;font-size:14px;line-height:1.6;">
        After verifying this code, you'll be able to set a new password.
      </p>
      <p style="margin:0;color:#ef4444;font-size:14px;font-weight:500;">
        If you didn't request a password reset, please secure your account immediately.
      </p>
    `);
  }

  private passwordChangedTemplate(): string {
    return this.baseLayout(`
      <h2 style="margin:0 0 16px;color:#111827;font-size:22px;font-weight:600;">Your password was changed</h2>
      <p style="margin:0 0 24px;color:#4b5563;font-size:16px;line-height:1.6;">
        The password for your ${this.appName} account was just changed. All other sessions have been signed out.
      </p>
      <p style="margin:0;color:#ef4444;font-size:14px;font-weight:500;">
        If this wasn't you, reset your password immediately and contact support &mdash; someone may have access to your account.
      </p>
    `);
  }

  private loginOtpTemplate(code: string): string {
    return this.baseLayout(`
      <h2 style="margin:0 0 16px;color:#111827;font-size:22px;font-weight:600;">Your login code</h2>
      <p style="margin:0 0 24px;color:#4b5563;font-size:16px;line-height:1.6;">
        Use this code to log in to your ${this.appName} account. It expires in <strong>10 minutes</strong>.
      </p>
      <div style="background-color:#f0fdf4;border:2px dashed #86efac;border-radius:12px;padding:24px;text-align:center;margin:0 0 24px;">
        <span style="font-size:36px;font-weight:700;letter-spacing:8px;color:#166534;font-family:'Courier New',monospace;">${code}</span>
      </div>
      <p style="margin:0;color:#6b7280;font-size:14px;line-height:1.6;">
        If you didn't try to log in, someone might be trying to access your account.
      </p>
    `);
  }
}
