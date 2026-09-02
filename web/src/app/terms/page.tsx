import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage } from "@/components/legal/LegalPage";

// Like the privacy policy, written against the implementation rather than from
// a template. The numbers here are the ones in api/src/lib/pricing and
// api/src/lib/wallet, and if those change this page is wrong in a way that
// matters more than usual — a stated price is an offer.
//
// The clause that earns its place is "Ad spend is not our fee". On
// billing_mode = 'platform' the org's own card backs the advertiser's Google
// account and we recover the money afterwards through the prepaid wallet. That
// is the largest financial exposure in the company, and before this page it was
// governed by nothing written down. MIN_FUNDED_DAYS, the zero-balance pause and
// the advertiser's obligation to repay all appear here because all three are
// what make that exposure bounded.
//
// The refund rule for the cinematic add-on mirrors isRefundable() in
// lib/cinematic/policy.ts exactly — paid, producing and failed are refundable,
// delivered is not. Do not soften the wording without changing the function.

const CONTACT = "legal@3pandalabs.com";

export const metadata: Metadata = {
  title: "Terms of Service — AdVault",
  description:
    "The agreement between you and 3PandaLabs LLC for using AdVault: what we do, what you pay, and who is responsible for what.",
};

export default function TermsPage() {
  return (
    <LegalPage
      title="Terms of Service"
      effective="2 September 2026"
      summary="You pay us to make your ads and, on the managed plan, to run them. You are responsible for the offers you advertise and for honouring them. We do not guarantee results, and nothing here is a promise that advertising will work."
    >
      <h2>1. Who this agreement is with</h2>
      <p>
        AdVault is operated by <strong>3PandaLabs LLC</strong>, a limited liability
        company formed in the State of New Jersey, United States. In these terms,
        &ldquo;we&rdquo; and &ldquo;us&rdquo; mean 3PandaLabs LLC, and &ldquo;you&rdquo;
        means the business using AdVault and the person agreeing to these terms on its
        behalf.
      </p>
      <p>
        By creating an account you accept these terms. If you are agreeing on behalf of a
        company, you confirm you are authorised to bind it.
      </p>

      <h2>2. What AdVault does</h2>
      <p>
        You give us your business details, an offer, and a few photographs. We write a
        script, produce video advertisements in widescreen and vertical formats, and — on
        the managed plan — launch and run a geographically targeted campaign on Google
        Ads and YouTube on your behalf.
      </p>
      <p>
        <strong>
          We are a tool, not an advertising agency, and we do not guarantee results.
        </strong>{" "}
        We do not promise any number of views, clicks, enquiries, customers or sales, and
        we do not promise that any particular advertisement will be approved by Google or
        will perform in any particular way. Advertising outcomes depend on your offer,
        your prices, your market and your competitors, none of which we control.
      </p>

      <h2>3. Your account</h2>
      <p>
        You must be at least 18 and using AdVault for a real business. Keep your details
        accurate and your password to yourself; you are responsible for everything done
        through your account. Tell us promptly at{" "}
        <a href={"mailto:" + CONTACT}>{CONTACT}</a> if you think someone else has access
        to it.
      </p>

      <h2>4. Plans and fees</h2>
      <p>Two plans, charged monthly in advance:</p>
      <table>
        <thead>
          <tr>
            <th>Plan</th>
            <th>India</th>
            <th>United States</th>
            <th>What you get</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Offer</td>
            <td>₹999/month</td>
            <td>$39/month</td>
            <td>Three fresh videos a month. No advertising is bought.</td>
          </tr>
          <tr>
            <td>Managed</td>
            <td>₹1,499/month</td>
            <td>$79/month</td>
            <td>The same videos, plus a live campaign we run for you.</td>
          </tr>
        </tbody>
      </table>
      <p>
        The managed figure is <strong>our fee only</strong>. It does not include what
        Google charges to show your advertisement — see the next section, which is the
        most important part of this page.
      </p>
      <p>
        We may also offer one-off extras. The <strong>cinematic advertisement</strong>{" "}
        currently costs ₹2,999 or $99, reduced to ₹999 or $29 the first time you buy one.
        Prices shown in the product at the time you buy are the ones that apply. We may
        change prices for future billing periods, and will tell you before a change
        affects you.
      </p>

      <h2>5. Ad spend is not our fee</h2>
      <p>
        Money paid to Google to show your advertisement is separate from anything you pay
        us, and it is always ultimately your cost. There are two arrangements, and you
        will know which one applies to you because they are set up differently:
      </p>
      <ul>
        <li>
          <strong>Your own Google account.</strong> You connect an account with your own
          card on it. Google bills you directly, we never touch that money, and your
          budget is between you and Google.
        </li>
        <li>
          <strong>An account we provide.</strong> Where we set up an advertising account
          for you under our own manager account, Google may bill{" "}
          <strong>us</strong> for your advertising.{" "}
          <strong>
            You agree to repay us in full for advertising spend we fund on your behalf.
          </strong>
        </li>
      </ul>
      <p>
        In the second case you keep a prepaid balance with us, and the arrangement is
        bounded on purpose. A campaign we fund will not go live unless your balance covers
        at least <strong>three days</strong> of its daily budget, and we automatically
        pause it at Google when the balance reaches zero. Neither control is a guarantee:
        Google reports spend to us with a delay, so a campaign can overspend a balance
        before we can pause it, and you remain responsible for the difference.
      </p>
      <p>
        Unused balance is refundable to you on request, less any spend already incurred.
        We do not pay interest on it.
      </p>

      <h2>6. Cancelling, and when we refund</h2>
      <p>
        You can cancel a monthly plan at any time from your dashboard. Cancellation takes
        effect at the end of the period you have paid for; you keep the service until
        then, and we do not pro-rate a partial month.
      </p>
      <p>
        <strong>Videos already produced are yours to keep</strong>, including after you
        cancel.
      </p>
      <p>For the cinematic advertisement, which is bought individually:</p>
      <ul>
        <li>
          <strong>Before we deliver it, you get a full refund</strong> if you ask —
          including when production has started, and automatically if production fails.
        </li>
        <li>
          <strong>Once it is delivered, it is not refundable</strong>, because it was made
          for you and cannot be resold.
        </li>
      </ul>
      <p>
        Beyond that, if we have plainly failed to deliver what you paid for, write to us
        and we will sort it out. We would rather refund an unhappy customer than argue
        with one.
      </p>

      <h2>7. Your photographs and your content</h2>
      <p>
        You keep ownership of everything you give us. By uploading, you confirm you have
        the right to use it — including permission from anyone identifiable in a
        photograph — and you give us permission to use it for the purpose of making and
        running your advertisements, and for nothing else. That permission ends when you
        delete the material or close your account, except where it is already part of a
        published advertisement.
      </p>

      <h2>8. Who owns the finished advertisement</h2>
      <p>
        <strong>You may use the videos we produce for you however you like</strong> —
        elsewhere on the internet, in your shop, on other platforms — for as long as you
        want, including after you stop paying us. We keep ownership of AdVault itself: the
        software, the templates and the way it works.
      </p>
      <p>
        Video produced by artificial intelligence carries some legal uncertainty about
        copyright that nobody has settled yet, and we cannot promise you exclusive rights
        in generated footage.
      </p>

      <h2>9. What you are responsible for</h2>
      <p>
        The advertisement speaks in your business&apos;s voice, so the claims in it are
        yours. You are responsible for:
      </p>
      <ul>
        <li>
          <strong>Your offer being true, and being honoured.</strong> If you advertise a
          price or a discount, you must sell at it for as long as the advertisement runs.
        </li>
        <li>
          <strong>The legality of what you advertise</strong>, including licences your
          trade requires, and the advertising rules that apply to you — in India the ASCI
          code and the Consumer Protection Act, in the United States the FTC&apos;s
          truth-in-advertising rules.
        </li>
        <li>
          <strong>Google&apos;s own advertising policies</strong>, which apply to every
          campaign and which Google enforces, not us.
        </li>
        <li>
          <strong>Your website and your landing page</strong>, and what happens after
          someone clicks.
        </li>
      </ul>
      <p>
        We review very little of this. We add captions and a voiceover for the factual
        claims in your advertisement precisely so that those claims are ones you wrote,
        rather than something a video model invented — but we do not verify that they are
        true, and we cannot.
      </p>

      <h2>10. What we will not advertise</h2>
      <p>
        We may refuse or remove any advertisement, and may suspend or close an account,
        where the content is illegal, deceptive, hateful, sexual, or promotes weapons,
        drugs, gambling or anything else we judge unsuitable — or where you use AdVault to
        advertise a business other than your own. We will tell you why, and we will refund
        anything you paid for work we then refuse to do.
      </p>

      <h2>11. Services we depend on</h2>
      <p>
        AdVault runs on top of Google Ads, YouTube, WhatsApp and other services described
        in our <Link href="/privacy">Privacy Policy</Link>. Their terms apply to you as
        well as to us. If Google disapproves your advertisement, suspends your account, or
        changes what its API allows, we may be unable to deliver part of the service, and{" "}
        <strong>we cannot overrule their decisions</strong>. Where that stops us
        delivering something you have paid for, we refund it.
      </p>

      <h2>12. Availability</h2>
      <p>
        We aim to keep AdVault running but do not promise any particular level of
        availability. We may change or discontinue features. If we discontinue something
        you are paying for, we will tell you and refund the unused part of your period.
      </p>

      <h2>13. Suspension and closing your account</h2>
      <p>
        We may suspend or close your account if you break these terms, if a payment fails
        and stays unpaid, or if you owe us money for advertising we funded. You can close
        your account at any time. Amounts you already owe survive closure, as do sections
        14 to 17 below.
      </p>

      <h2>14. Disclaimer</h2>
      <p>
        Except where the law does not allow us to say so, AdVault is provided
        &ldquo;as is&rdquo;. We disclaim all implied warranties, including
        merchantability, fitness for a particular purpose and non-infringement. We do not
        warrant that the service will be uninterrupted or error-free, or that any
        advertisement will achieve anything.
      </p>

      <h2>15. Limit of our liability</h2>
      <p>
        To the extent the law allows, we are not liable for indirect or consequential
        loss, lost profits, lost business, lost data or lost goodwill.
      </p>
      <p>
        <strong>
          Our total liability to you for any claim is limited to the fees you paid us in
          the twelve months before it arose
        </strong>{" "}
        — meaning our own fees, not advertising spend. Nothing here limits liability that
        cannot lawfully be limited, including for fraud.
      </p>

      <h2>16. You cover us for your advertisements</h2>
      <p>
        If someone brings a claim against us because of what you advertised, what you
        uploaded, an offer you did not honour, or your breach of these terms, you agree to
        cover our reasonable costs and any damages.
      </p>

      <h2>17. Which law applies</h2>
      <p>
        These terms are governed by the laws of the{" "}
        <strong>State of New Jersey, United States</strong>, without regard to its
        conflict-of-laws rules, and the courts of New Jersey have jurisdiction.
      </p>
      <p>
        If you are a consumer in a country whose law gives you rights you cannot sign
        away, those rights still apply and nothing here removes them.
      </p>
      <p>
        Before either of us goes to court, please write to{" "}
        <a href={"mailto:" + CONTACT}>{CONTACT}</a>. Most things are cheaper to fix by
        email than by lawyer.
      </p>

      <h2>18. Changes to these terms</h2>
      <p>
        We may update these terms. For anything that materially affects you — price
        changes, new obligations, changes to the refund rules — we will email you at least
        thirty days before it takes effect, and you may cancel rather than accept. Smaller
        corrections take effect when we update the date at the top.
      </p>

      <h2>19. The rest</h2>
      <p>
        These terms, with the <Link href="/privacy">Privacy Policy</Link>, are the whole
        agreement between us. If a court finds part of them unenforceable, the rest still
        stands. Not enforcing something once does not waive it. You may not transfer this
        agreement without our consent; we may transfer it if the business is sold, on
        notice to you.
      </p>

      <h2>Contact</h2>
      <p>
        3PandaLabs LLC, New Jersey, United States —{" "}
        <a href={"mailto:" + CONTACT}>{CONTACT}</a>.
      </p>
    </LegalPage>
  );
}
