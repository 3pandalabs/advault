import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage } from "@/components/legal/LegalPage";

// DRAFT, pending legal review (2026-11-20). Part of the Terms of Service
// (TERMS_VERSION in lib/compliance/texts.ts). What it describes is enforced in
// the API (api/src/lib/compliance, CLAUDE.md "Client attestation &
// compliance"):
//   - the two ticks on every order, generate, upload and launch are
//     ATTESTATION_ACCURACY_TEXT / ATTESTATION_MEDIA_TEXT, recorded with IP and
//     user agent in ad_attestations;
//   - "wording we check before launch" are the REVIEW rules in
//     lib/compliance/claimRules.ts (health cures, finance/crypto, guaranteed
//     results), launch answers 409 needs_review until an admin approves;
//   - removal is the admin takedown (pause at Google, videos private).
// Change this page with those rules. Market-neutral: US and India.

const CONTACT = "3pandas@3pandalabs.com";

export const metadata: Metadata = {
  title: "Content Policy",
  description: "What you may advertise with AdVault, what you confirm about every ad, and how ads are reviewed, reported and removed.",
};

export default function ContentPolicyPage() {
  return (
    <LegalPage
      title="Content Policy"
      effective="19 November 2026"
      summary="Your ads speak for your business, so you are responsible for every claim, photo and video in them. Tell the truth, use only media you have the rights to, and don't advertise anything on the list below. We may refuse or remove any ad at any time."
      notice={
        <>
          <strong>DRAFT — pending legal review.</strong> This policy is part of our{" "}
          <Link href="/terms">Terms of Service</Link> and applies now; its wording may change
          after review, and we will ask you to accept it again if it does.
        </>
      }
    >
      <h2>1. What you confirm about every ad</h2>
      <p>
        Before we make, re-make or launch an ad, and before you upload your own video, you tick
        two boxes. By ticking them you warrant to 3PandaLabs LLC that:
      </p>
      <ul>
        <li>
          <strong>All information and claims in the ad are true, accurate and lawful</strong>,
          including your offer, prices, discounts, deadlines, licences, badges and anything else
          you tell us about your business, and you accept responsibility for them.
        </li>
        <li>
          <strong>You own or have the rights to every photo, video, logo and piece of music</strong>{" "}
          you upload, and you have the consent of every person who can be identified in them.
        </li>
      </ul>
      <p>
        We record each confirmation with the exact words you agreed to, the date and time, your
        IP address and browser, and a copy of what the ad said at that moment. See the{" "}
        <Link href="/privacy">Privacy Policy</Link>.
      </p>

      <h2>2. You are responsible for your ads</h2>
      <p>
        The ad is made from what you give us. Our script writer is instructed to use only facts
        you provided and never to invent statistics, reviews, testimonials, awards, rankings or
        claims like &ldquo;the best&rdquo;, but you must read your ad before it runs and fix or
        stop anything that is not true. You are responsible for following the advertising and
        consumer-protection laws that apply to your business wherever your ad is shown, and
        Google&rsquo;s advertising policies.
      </p>
      <p>
        <strong>You agree to indemnify 3PandaLabs LLC</strong> — to cover us, our members and
        staff — against any claim, fine, loss or cost (including reasonable legal fees) that
        arises from your ads, your claims, your media, your offer or your breach of this policy,
        as set out in section 16 of the <Link href="/terms">Terms of Service</Link>.
      </p>

      <h2>3. What you may not advertise</h2>
      <ul>
        <li>Anything illegal where the ad is shown, or illegal products and services.</li>
        <li>Weapons, ammunition and explosives.</li>
        <li>Adult or sexual content and services.</li>
        <li>Tobacco, vaping products, recreational drugs and drug paraphernalia.</li>
        <li>Gambling, betting and lotteries.</li>
        <li>
          Health claims that a product or treatment cures, heals or treats a disease, &ldquo;miracle&rdquo;
          results, or promises of weight loss.
        </li>
        <li>
          Cryptocurrency, investments with promised returns, &ldquo;no credit check&rdquo; or payday
          loans, unless we have reviewed and approved the ad first.
        </li>
        <li>
          Housing, job or credit ads that exclude or prefer people by race, religion, sex, family
          status, age, disability, national origin or any other protected characteristic.
        </li>
        <li>Counterfeit goods, or anything that infringes someone else&rsquo;s trademark or copyright.</li>
        <li>Hate, harassment, threats, or content that attacks a person or group.</li>
        <li>
          Fake or misleading reviews, testimonials, statistics, ratings or awards, and anything
          else designed to mislead.
        </li>
      </ul>

      <h2>4. Wording we check before an ad runs</h2>
      <p>
        Some wording is allowed but checked by a person at AdVault before the ad can launch:
        health claims (cures, miracle results, weight loss), investment, crypto and lending
        offers, and &ldquo;guaranteed results&rdquo;. You can still make the ad; the launch waits
        until we approve it, usually within a working day. If you later change the wording to
        add a new claim of this kind, it is checked again. Other wording (for example
        &ldquo;#1&rdquo;, &ldquo;the best&rdquo; or a guarantee) shows a warning with the reason
        while you type; it is your decision, and your responsibility, to keep it.
      </p>

      <h2>5. We may refuse or remove any ad</h2>
      <p>
        We may refuse to make or launch an ad, and may remove an ad at any time, with or without
        notice, if we believe it breaks this policy, the law or Google&rsquo;s policies, or if
        it is reported and we judge the report credible. Removing an ad means we pause the
        campaign, make its videos private on YouTube, and do not make, launch or restart it
        again. We may also suspend or close the account. Money already spent at Google is not
        refunded for an ad removed under this policy; any unused ad budget is handled as the{" "}
        <Link href="/terms">Terms of Service</Link> describe.
      </p>

      <h2>6. Reporting an ad</h2>
      <p>
        Anyone can report an AdVault ad — every ad we publish to YouTube carries a &ldquo;Report
        this ad&rdquo; link, or use <Link href="/report">the report page</Link>. A person reads
        every report.
      </p>

      <h2>Contact</h2>
      <p>
        Questions about this policy, or an ad you think we removed by mistake:{" "}
        <a href={"mailto:" + CONTACT}>{CONTACT}</a>.
      </p>
    </LegalPage>
  );
}
