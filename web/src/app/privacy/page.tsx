import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage } from "@/components/legal/LegalPage";

// Every factual claim on this page was checked against the code rather than
// copied from a template, because a privacy policy that describes a system we
// do not run is worse than none: it is a written misrepresentation, and the
// Google Ads API review reads it against the live product.
//
// If you change what the app collects, who it sends data to, or how long it is
// kept, this page changes in the same PR. The specific things that pin it to
// the implementation:
//
//   - the subprocessor table mirrors the configured providers in api/src/lib
//   - "no cookies, no analytics" is true only while web/src stays free of them
//   - the log/metric retention figures come from the monitoring stack
//     (Loki 14 days, VictoriaMetrics 3 months)
//   - AES-256-GCM at rest is api/src/lib/crypto.ts, bcrypt is auth/password.ts
//
// The Limited Use paragraph under "Google account data" is required near-verbatim
// by the Google API Services User Data Policy. Do not paraphrase it.

const CONTACT = "privacy@3pandalabs.com";

export const metadata: Metadata = {
  title: "Privacy Policy — AdVault",
  description:
    "What AdVault collects, why, who it is shared with, and how to have it deleted.",
};

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy Policy"
      effective="20 August 2026"
      summary="We collect what we need to make your ad and run your campaign, and nothing else. We do not sell your data, we do not track you around the internet, and this site sets no cookies at all."
    >
      <h2>Who we are</h2>
      <p>
        AdVault is a product of <strong>3PandaLabs LLC</strong>, a limited liability
        company registered in the United States. In this policy, &ldquo;we&rdquo; and
        &ldquo;us&rdquo; mean 3PandaLabs LLC, and &ldquo;you&rdquo; means the business or
        person using AdVault.
      </p>
      <p>
        For anything in this policy, including a request to see or delete your data,
        write to <a href={"mailto:" + CONTACT}>{CONTACT}</a>. A person reads that address
        and we aim to reply within seven days.
      </p>

      <h2>What we collect</h2>
      <p>
        Almost all of it is information you type into AdVault yourself. We do not buy data
        about you, and we collect nothing at all before you create an account.
      </p>
      <ul>
        <li>
          <strong>Your account</strong> — email address, a password (stored only as a
          bcrypt hash, never as text we can read), your name, your business name and
          category, your phone number, and your country.
        </li>
        <li>
          <strong>Your campaign</strong> — what you sell, the offer you are running, your
          call to action, your website address, the pin or ZIP codes you want to reach,
          the radius around them, and your daily budget.
        </li>
        <li>
          <strong>Photos you upload</strong> — the pictures of your shop, team or work
          that go into the video, plus the original filename, file type and size.
        </li>
        <li>
          <strong>Your Google Ads connection</strong> — see the separate section below.
        </li>
        <li>
          <strong>Payment records</strong> — the amount, currency, date, status and the
          payment provider&apos;s reference for each transaction.{" "}
          <strong>We never see or store your card or bank details.</strong> Those go
          directly to the payment provider and never reach our servers.
        </li>
        <li>
          <strong>WhatsApp messages</strong> — only if you turn on the monthly offer
          prompt. We store your phone number and the text of messages between you and
          AdVault about your offers.
        </li>
        <li>
          <strong>What we generate for you</strong> — the ad script, the finished video
          and voiceover, and the YouTube video ID once it is published.
        </li>
        <li>
          <strong>Technical records</strong> — server logs containing IP addresses and
          request paths, and a session token in your browser that keeps you logged in.
        </li>
      </ul>

      <h3>What we do not collect</h3>
      <ul>
        <li>
          <strong>No cookies and no analytics.</strong> This site sets no cookies, and
          there is no Google Analytics, no advertising pixel and no third-party tracker
          anywhere on it. Your login is held in browser storage, not a tracking cookie.
        </li>
        <li>
          <strong>No card or bank details</strong>, as above.
        </li>
        <li>
          <strong>Nothing about your own customers.</strong> AdVault targets areas — pin
          codes and a radius — not individuals. We hold no list of the people who see or
          click your ad, and we cannot identify them.
        </li>
        <li>
          <strong>No location tracking.</strong> The only location we hold is the area you
          typed in as your target.
        </li>
      </ul>

      <h2>Why we use it</h2>
      <p>
        We use the information above to create your ad, run and monitor your campaign,
        take payment, keep your account secure, send you service messages about your own
        campaigns, and meet our tax and accounting obligations. We do not use it for
        anything else, and we do not sell it or rent it to anybody, ever.
      </p>

      <h2>Google account data</h2>
      <p>
        If you connect an existing Google Ads account, you grant AdVault access through
        Google&apos;s own consent screen, and you can withdraw it at any time from your{" "}
        <a
          href="https://myaccount.google.com/permissions"
          target="_blank"
          rel="noreferrer noopener"
        >
          Google account permissions page
        </a>
        . From that connection we store your Google Ads customer ID, the account name, its
        currency and time zone, and a refresh token which lets us keep managing your
        campaign without asking you to log in again.
      </p>
      <p>
        <strong>
          That refresh token is encrypted at rest with AES-256-GCM, under a key held
          separately from the database
        </strong>{" "}
        — it is the one credential we hold that could be used to spend your money. We use
        it only to create, update, pause and report on the campaigns you asked us to run.
      </p>
      <p>
        AdVault&apos;s use and transfer of information received from Google APIs to any
        other app will adhere to the{" "}
        <a
          href="https://developers.google.com/terms/api-services-user-data-policy"
          target="_blank"
          rel="noreferrer noopener"
        >
          Google API Services User Data Policy
        </a>
        , including the Limited Use requirements.
      </p>
      <p>
        In particular: we do not transfer Google user data to third parties except as
        needed to provide AdVault to you, or for security or legal reasons; we do not use
        it to advertise to you; we do not sell it; and{" "}
        <strong>
          we never send data retrieved from your Google Ads account to any AI provider
        </strong>
        . The only material that reaches an AI provider is the campaign description you
        wrote yourself.
      </p>

      <h2>Who else sees your data</h2>
      <p>
        We use the following companies to run AdVault. Each receives only what it needs
        for its part of the job, and none of them may use your data for their own
        purposes.
      </p>
      <table>
        <thead>
          <tr>
            <th>Who</th>
            <th>What they get</th>
            <th>Why</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Google (Ads and YouTube)</td>
            <td>Your campaign settings and your finished video</td>
            <td>To run the ad and host the video</td>
          </tr>
          <tr>
            <td>Cloudflare</td>
            <td>Your uploaded photos and finished videos; site traffic</td>
            <td>File storage, and serving the website</td>
          </tr>
          <tr>
            <td>Hetzner</td>
            <td>Everything in the database</td>
            <td>The servers the application runs on</td>
          </tr>
          <tr>
            <td>AI providers for script, video and voice</td>
            <td>Your business name, category and offer text</td>
            <td>To write the script and produce the video</td>
          </tr>
          <tr>
            <td>Payment providers</td>
            <td>Your name, email and the amount</td>
            <td>To take payment. They, not we, handle your card</td>
          </tr>
          <tr>
            <td>Meta (WhatsApp)</td>
            <td>Your phone number and message text</td>
            <td>Only if you turn on monthly offer prompts</td>
          </tr>
        </tbody>
      </table>
      <p>
        We choose providers whose terms do not permit training AI models on customer
        content, and we do not consent to such training on your behalf. We may change a
        provider within a category above; if a change materially affects your privacy we
        will tell you before it takes effect.
      </p>
      <p>
        Beyond these, we will disclose your information only where the law requires it, or
        where it is necessary to protect our rights or someone&apos;s safety. If we are
        ever compelled to hand over your data, we will tell you unless we are legally
        forbidden from doing so.
      </p>

      <h2>Where your data lives</h2>
      <p>
        Our servers and database are in <strong>Falkenstein, Germany</strong>. Uploaded
        photos and videos are stored on Cloudflare&apos;s network. Because 3PandaLabs LLC
        is a United States company, our staff access this data from outside the country
        you are in. By using AdVault you agree to your information being stored and
        processed in these places.
      </p>

      <h2>How long we keep it</h2>
      <ul>
        <li>
          <strong>Your account and campaigns</strong> — for as long as your account is
          open, and for twelve months after you close it, in case you come back.
        </li>
        <li>
          <strong>Uploaded photos and finished videos</strong> — until you delete them, or
          twelve months after your account closes.
        </li>
        <li>
          <strong>Payment and invoice records</strong> — up to eight years, because tax
          law requires us to keep books of account. These we cannot delete on request.
        </li>
        <li>
          <strong>Server logs</strong> — fourteen days.
        </li>
        <li>
          <strong>Performance metrics</strong> — three months.
        </li>
        <li>
          <strong>Your Google refresh token</strong> — deleted as soon as you disconnect
          the account, or close your own.
        </li>
      </ul>

      <h2>Your rights</h2>
      <p>You can ask us at any time to:</p>
      <ul>
        <li>show you a copy of everything we hold about you;</li>
        <li>correct anything that is wrong;</li>
        <li>
          delete your account and its data, subject to the financial records we are
          required to keep;
        </li>
        <li>stop sending you anything that is not essential to your service.</li>
      </ul>
      <p>
        Write to <a href={"mailto:" + CONTACT}>{CONTACT}</a> and we will act within thirty
        days. We will not charge you and we will not ask why. If you are in India, these
        rights are yours under the Digital Personal Data Protection Act 2023, and the same
        address is our grievance contact; if you are unhappy with our answer you may
        complain to the Data Protection Board of India.
      </p>

      <h2>Security</h2>
      <p>
        Passwords are stored as bcrypt hashes and Google refresh tokens are encrypted with
        AES-256-GCM. All traffic to the site and the API is encrypted in transit. Uploads
        go straight from your browser to storage over short-lived signed links, so your
        photos never sit on an intermediate server. Administrative access to our
        infrastructure is restricted by identity and by network address.
      </p>
      <p>
        No system is perfectly secure. If a breach ever affects your data we will tell you
        and the relevant authority promptly, describe what happened, and say what we are
        doing about it.
      </p>

      <h2>Children</h2>
      <p>
        AdVault is a tool for businesses and is not intended for anyone under 18. We do
        not knowingly collect information from children. If you believe a child has given
        us data, write to us and we will delete it.
      </p>

      <h2>Changes to this policy</h2>
      <p>
        If we change this policy we will update the date at the top. For anything that
        materially affects your privacy we will email you before the change takes effect,
        rather than relying on you to notice.
      </p>

      <h2>Contact</h2>
      <p>
        3PandaLabs LLC, United States — <a href={"mailto:" + CONTACT}>{CONTACT}</a>. The
        rest of the product is at the <Link href="/">AdVault home page</Link>.
      </p>
    </LegalPage>
  );
}
