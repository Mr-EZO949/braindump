import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import styles from "../legal.module.css";

export const metadata: Metadata = {
  title: "Terms of Service · BrainDump",
  description: "The rules of using BrainDump.",
};

export default function TermsOfServicePage() {
  return (
    <main className={styles.page}>
      <nav className={styles.nav}>
        <Link href="/" className={styles.brand} aria-label="BrainDump home">
          <Image
            src="/logo_withtext.svg"
            alt="BrainDump"
            width={140}
            height={28}
            className={styles.brandImg}
          />
        </Link>
        <Link href="/" className={styles.backLink}>
          ← Back to home
        </Link>
      </nav>

      <div className={styles.container}>
        <header className={styles.header}>
          <span className={styles.eyebrow}>Legal</span>
          <h1 className={styles.title}>Terms of Service</h1>
          <p className={styles.effective}>Effective: 14 May 2026 · Last updated: 14 May 2026</p>

          <p className={styles.lede}>
            These Terms of Service (&ldquo;Terms&rdquo;) are a binding agreement between you and BrainDump,
            operated by [YOUR_LEGAL_NAME] (&ldquo;we,&rdquo; &ldquo;us,&rdquo; &ldquo;our&rdquo;).
            They govern your access to and use of our website, mobile experience, API, and the BrainDump
            application (collectively, the &ldquo;Service&rdquo;).
          </p>

          <div className={styles.callout}>
            <p>
              <strong>Important.</strong> These Terms include an arbitration clause and class-action waiver in Section 14. They limit how disputes are resolved. By using the Service, you agree to be bound by these Terms. If you do not agree, do not use the Service.
            </p>
          </div>

          <div className={styles.toc}>
            <span className={styles.tocTitle}>Contents</span>
            <ol className={styles.tocList}>
              <li><a href="#agreement">Agreement to terms</a></li>
              <li><a href="#eligibility">Eligibility</a></li>
              <li><a href="#account">Your account</a></li>
              <li><a href="#service">The Service</a></li>
              <li><a href="#your-content">Your content</a></li>
              <li><a href="#acceptable-use">Acceptable use</a></li>
              <li><a href="#ai">AI features &amp; limitations</a></li>
              <li><a href="#beta">Beta &amp; early access</a></li>
              <li><a href="#fees">Fees and payment</a></li>
              <li><a href="#termination">Termination</a></li>
              <li><a href="#warranty">Disclaimer of warranties</a></li>
              <li><a href="#liability">Limitation of liability</a></li>
              <li><a href="#indemnification">Indemnification</a></li>
              <li><a href="#disputes">Governing law &amp; disputes</a></li>
              <li><a href="#general">General</a></li>
              <li><a href="#contact">Contact</a></li>
            </ol>
          </div>
        </header>

        <section className={styles.section} id="agreement">
          <h2 className={styles.h2}>1. Agreement to terms</h2>
          <p>
            By creating an account, joining the waitlist, or otherwise using the Service, you agree to these Terms and to our <Link href="/privacy">Privacy Policy</Link>. If you are using the Service on behalf of an organization, you represent that you have authority to bind that organization to these Terms; &ldquo;you&rdquo; then refers to both you personally and that organization.
          </p>
          <p>
            We may update these Terms from time to time. If we make material changes, we&apos;ll notify you in-app or by email at least 30 days before the changes take effect. Continued use after the effective date means you accept the updated Terms.
          </p>
        </section>

        <section className={styles.section} id="eligibility">
          <h2 className={styles.h2}>2. Eligibility</h2>
          <p>You may use the Service only if you:</p>
          <ul>
            <li>Are at least <strong>13 years old</strong> (or <strong>16</strong> if you reside in the European Economic Area or the United Kingdom);</li>
            <li>Have the legal capacity to enter into a contract in your jurisdiction;</li>
            <li>Are not barred from using the Service under any applicable law (including export controls and sanctions); and</li>
            <li>Have not previously been terminated from the Service for violating these Terms.</li>
          </ul>
        </section>

        <section className={styles.section} id="account">
          <h2 className={styles.h2}>3. Your account</h2>
          <p>
            To use the Service, you need an account. You agree to:
          </p>
          <ul>
            <li>Provide accurate, current information when registering and keep it up to date;</li>
            <li>Keep your password confidential and not share account access with others;</li>
            <li>Be responsible for all activity that happens under your account; and</li>
            <li>Notify us immediately at <strong>[CONTACT_EMAIL]</strong> if you suspect unauthorized access.</li>
          </ul>
          <p>
            We may suspend or terminate accounts that violate these Terms (see <a href="#termination">Section 10</a>).
          </p>
        </section>

        <section className={styles.section} id="service">
          <h2 className={styles.h2}>4. The Service</h2>
          <p>
            BrainDump is an AI-powered productivity application that helps you capture, organize, and act on your tasks, habits, goals, ideas, journal entries, and other personal information through a graph-based interface.
          </p>
          <p>
            We may modify, update, suspend, or discontinue parts of the Service at any time. When changes are material and adverse, we will give you reasonable notice. We are not liable for any modification, suspension, or discontinuation, but if we discontinue the Service entirely, we&apos;ll give you reasonable time to export your data.
          </p>
        </section>

        <section className={styles.section} id="your-content">
          <h2 className={styles.h2}>5. Your content</h2>

          <h3 className={styles.h3}>5.1 Ownership</h3>
          <p>
            Everything you put into BrainDump &mdash; brain dumps, nodes, edges, chat messages, planner entries, reflections, and anything else (&ldquo;Your Content&rdquo;) &mdash; remains yours. We claim no ownership of Your Content.
          </p>

          <h3 className={styles.h3}>5.2 License to us</h3>
          <p>
            To operate the Service, you grant us a worldwide, non-exclusive, royalty-free license to host, store, copy, transmit, process, display, modify (for technical purposes such as resizing or format conversion), and create derivative works of Your Content. This license exists solely so we can run the Service for you &mdash; for example, to send your content to AI providers, generate embeddings, sync between devices, back up data, and produce derived insights like weekly reflections. It ends when you delete Your Content or your account, except where retention is legally required or for backups that are routinely overwritten.
          </p>

          <h3 className={styles.h3}>5.3 Your representations</h3>
          <p>You represent and warrant that:</p>
          <ul>
            <li>You own or have the necessary rights to all of Your Content;</li>
            <li>Your Content does not violate any law or infringe any third party&apos;s rights (privacy, publicity, copyright, trademark, trade secret, etc.); and</li>
            <li>You have obtained any consents required to enter content about other people.</li>
          </ul>

          <h3 className={styles.h3}>5.4 Feedback</h3>
          <p>
            If you give us feedback, suggestions, or ideas about the Service, you grant us a perpetual, irrevocable, royalty-free license to use them without restriction or compensation.
          </p>
        </section>

        <section className={styles.section} id="acceptable-use">
          <h2 className={styles.h2}>6. Acceptable use</h2>
          <p>You agree not to use the Service to:</p>
          <ul>
            <li>Violate any law or regulation, or infringe anyone&apos;s rights;</li>
            <li>Upload, store, or transmit content that is illegal, hateful, harassing, threatening, defamatory, sexually explicit involving minors, or otherwise objectionable;</li>
            <li>Attempt to gain unauthorized access to the Service, other users&apos; accounts, or our infrastructure;</li>
            <li>Reverse engineer, decompile, scrape, or attempt to extract source code or proprietary algorithms from the Service, except where this restriction is prohibited by law;</li>
            <li>Use the Service to develop a competing product or to train machine learning models on data we provide;</li>
            <li>Send unsolicited messages, spam, or malware through the Service;</li>
            <li>Probe, scan, or test the vulnerability of the Service without our prior written consent (responsible disclosures to <strong>[CONTACT_EMAIL]</strong> are welcome);</li>
            <li>Use bots, scrapers, or automated tools to access the Service except as expressly allowed by our public API and rate limits;</li>
            <li>Misrepresent your identity or affiliation with anyone; or</li>
            <li>Interfere with the Service or impose an unreasonable load on our infrastructure.</li>
          </ul>
        </section>

        <section className={styles.section} id="ai">
          <h2 className={styles.h2}>7. AI features &amp; limitations</h2>
          <p>
            BrainDump uses large language models and other machine-learning systems to extract structure from text, generate suggestions, answer questions, produce reflections, and power similar features (&ldquo;AI Features&rdquo;).
          </p>
          <p><strong>You acknowledge and agree that:</strong></p>
          <ul>
            <li>AI outputs are generated probabilistically and may be inaccurate, incomplete, misleading, or offensive;</li>
            <li>AI outputs are not advice. <strong>Do not rely on the Service for legal, medical, financial, safety, or other consequential decisions.</strong> Always seek qualified professional advice for important matters;</li>
            <li>The same input may produce different outputs at different times;</li>
            <li>We do not warrant the accuracy, completeness, or usefulness of any AI output;</li>
            <li>Your Content is processed by third-party AI providers (see our <Link href="/privacy">Privacy Policy</Link> for the current list). We require those providers to keep your data confidential and not use it to train their models, but we cannot guarantee zero risk in transmitting data to third parties;</li>
            <li>You are solely responsible for reviewing AI outputs before relying on them or sharing them.</li>
          </ul>
        </section>

        <section className={styles.section} id="beta">
          <h2 className={styles.h2}>8. Beta &amp; early access</h2>
          <p>
            The Service is provided in a pre-release / early-access state. It may contain bugs, be unavailable, lose data, or change without notice. Features may appear and disappear. We will try to give you reasonable warning of breaking changes but cannot guarantee any specific feature, level of performance, or uptime.
          </p>
          <p>
            <strong>Maintain your own backups of anything you can&apos;t afford to lose.</strong> Use the export feature in-app or contact us at <strong>[CONTACT_EMAIL]</strong> if you need a one-off export.
          </p>
        </section>

        <section className={styles.section} id="fees">
          <h2 className={styles.h2}>9. Fees and payment</h2>
          <p>
            During the waitlist and early-access period, the Service is provided <strong>free of charge</strong>.
          </p>
          <p>
            We may introduce paid plans in the future. If we do, we&apos;ll give you at least 30 days&apos; notice and the option to either upgrade, continue on a free tier (if offered), or export your data and close your account. Specific pricing, billing cycles, refund policies, and tax handling will be presented at checkout and incorporated into these Terms by reference at that time.
          </p>
        </section>

        <section className={styles.section} id="termination">
          <h2 className={styles.h2}>10. Termination</h2>

          <h3 className={styles.h3}>10.1 By you</h3>
          <p>You can stop using the Service and delete your account at any time from within the app or by emailing <strong>[CONTACT_EMAIL]</strong>. Deletion removes your content from our active systems within 30 days (subject to the backup window described in our <Link href="/privacy">Privacy Policy</Link>).</p>

          <h3 className={styles.h3}>10.2 By us</h3>
          <p>We may suspend or terminate your access if:</p>
          <ul>
            <li>You materially breach these Terms (including the acceptable use rules in <a href="#acceptable-use">Section 6</a>);</li>
            <li>We are legally required to do so;</li>
            <li>Your continued use poses a security, legal, or operational risk; or</li>
            <li>We discontinue the Service (we&apos;ll give reasonable notice and a chance to export).</li>
          </ul>
          <p>Where reasonable and lawful, we will give you notice and a chance to fix the problem before terminating.</p>

          <h3 className={styles.h3}>10.3 Effect of termination</h3>
          <p>
            On termination, your right to use the Service ends. Sections that by their nature should survive termination (including ownership, license to feedback, disclaimers, limitation of liability, indemnification, and dispute resolution) will survive.
          </p>
        </section>

        <section className={styles.section} id="warranty">
          <h2 className={styles.h2}>11. Disclaimer of warranties</h2>
          <p>
            <strong>THE SERVICE IS PROVIDED &ldquo;AS IS&rdquo; AND &ldquo;AS AVAILABLE,&rdquo; WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED.</strong> To the maximum extent permitted by law, we disclaim all warranties, including implied warranties of merchantability, fitness for a particular purpose, non-infringement, accuracy, and quiet enjoyment.
          </p>
          <p>
            We do not warrant that the Service will be uninterrupted, secure, or error-free; that defects will be corrected; that the Service or the servers that make it available are free of viruses or harmful components; or that the results of using the Service will meet your requirements.
          </p>
          <p>
            Some jurisdictions do not allow the disclaimer of certain warranties; in those jurisdictions, the disclaimers above apply to the maximum extent permitted by law, and you may have additional rights.
          </p>
        </section>

        <section className={styles.section} id="liability">
          <h2 className={styles.h2}>12. Limitation of liability</h2>
          <p>
            <strong>TO THE MAXIMUM EXTENT PERMITTED BY LAW, IN NO EVENT WILL WE BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY, OR PUNITIVE DAMAGES,</strong> including loss of profits, revenue, data, goodwill, or other intangible losses, arising out of or related to your use of (or inability to use) the Service, even if we have been advised of the possibility of such damages.
          </p>
          <p>
            <strong>OUR TOTAL CUMULATIVE LIABILITY</strong> arising out of or related to these Terms or the Service, whether in contract, tort, or otherwise, will not exceed the greater of <strong>(a) the amount you paid us for the Service in the twelve (12) months immediately before the event giving rise to the claim, or (b) one hundred U.S. dollars (USD $100)</strong>.
          </p>
          <p>
            Nothing in these Terms limits liability for: gross negligence, willful misconduct, fraud, death or personal injury caused by negligence, or any other liability that cannot be limited by applicable law (including certain rights under consumer protection laws in the EEA, UK, and other jurisdictions).
          </p>
        </section>

        <section className={styles.section} id="indemnification">
          <h2 className={styles.h2}>13. Indemnification</h2>
          <p>
            You agree to indemnify, defend, and hold harmless [YOUR_LEGAL_NAME], its affiliates, and their respective directors, officers, employees, and agents from and against any claims, liabilities, damages, losses, and expenses (including reasonable legal fees) arising out of or related to:
          </p>
          <ul>
            <li>Your use of the Service;</li>
            <li>Your violation of these Terms;</li>
            <li>Your violation of any third-party right, including any intellectual property or privacy right; or</li>
            <li>Your Content.</li>
          </ul>
          <p>We reserve the right, at our own expense, to assume the exclusive defense of any matter for which you are required to indemnify us, in which case you will cooperate in asserting any available defenses.</p>
        </section>

        <section className={styles.section} id="disputes">
          <h2 className={styles.h2}>14. Governing law &amp; disputes</h2>

          <h3 className={styles.h3}>14.1 Governing law</h3>
          <p>
            These Terms are governed by the laws of the State of <strong>Delaware, United States</strong>, without regard to its conflict of laws principles. The United Nations Convention on Contracts for the International Sale of Goods does not apply.
          </p>
          <p>
            If you reside in the European Economic Area, the United Kingdom, or another jurisdiction whose mandatory consumer protection laws apply to you, nothing in this section deprives you of the protection of those laws.
          </p>

          <h3 className={styles.h3}>14.2 Informal resolution</h3>
          <p>
            Before filing any formal claim, please contact us at <strong>[CONTACT_EMAIL]</strong> with a description of the dispute. We&apos;ll try to resolve it informally within 60 days.
          </p>

          <h3 className={styles.h3}>14.3 Binding arbitration</h3>
          <p>
            <strong>If we cannot resolve the dispute informally, any dispute, claim, or controversy arising out of or relating to these Terms or the Service will be resolved by binding individual arbitration</strong> administered by the American Arbitration Association (AAA) under its Consumer Arbitration Rules, in Wilmington, Delaware, USA. The arbitrator&apos;s decision will be final and binding. Judgment on the award may be entered in any court of competent jurisdiction.
          </p>
          <p>
            You may opt out of arbitration within 30 days of first accepting these Terms by emailing <strong>[CONTACT_EMAIL]</strong> with the subject line &ldquo;Arbitration Opt-Out&rdquo; and including your name, account email, and a statement that you opt out.
          </p>

          <h3 className={styles.h3}>14.4 Class action waiver</h3>
          <p>
            <strong>You and we agree to bring disputes only in an individual capacity</strong>, not as a plaintiff or class member in any class, collective, or representative action. The arbitrator may not consolidate more than one person&apos;s claims and may not preside over any form of representative proceeding.
          </p>

          <h3 className={styles.h3}>14.5 Exceptions</h3>
          <p>
            Either party may seek injunctive relief in court for actual or threatened infringement, misappropriation, or violation of intellectual property rights. Either party may also pursue claims that qualify in small-claims court (where the dispute remains there and is brought individually).
          </p>
        </section>

        <section className={styles.section} id="general">
          <h2 className={styles.h2}>15. General</h2>

          <h3 className={styles.h3}>15.1 Entire agreement</h3>
          <p>These Terms and our <Link href="/privacy">Privacy Policy</Link> constitute the entire agreement between you and us regarding the Service, replacing any prior agreement.</p>

          <h3 className={styles.h3}>15.2 Severability</h3>
          <p>If any provision is held unenforceable, the remaining provisions remain in full force, and the unenforceable provision will be modified to the minimum extent necessary to make it enforceable while preserving its intent.</p>

          <h3 className={styles.h3}>15.3 No waiver</h3>
          <p>Our failure to enforce a provision is not a waiver of our right to enforce it later.</p>

          <h3 className={styles.h3}>15.4 Assignment</h3>
          <p>You may not assign these Terms or your account without our prior written consent. We may assign these Terms to an affiliate, an acquirer, or a successor in a business transfer.</p>

          <h3 className={styles.h3}>15.5 No third-party beneficiaries</h3>
          <p>These Terms do not create any third-party beneficiary rights.</p>

          <h3 className={styles.h3}>15.6 Notices</h3>
          <p>
            We may give you notice by email (to the address associated with your account) or by posting in the Service. Legal notices to us must be sent to <strong>[YOUR_MAILING_ADDRESS]</strong>, with a copy to <strong>[CONTACT_EMAIL]</strong>.
          </p>

          <h3 className={styles.h3}>15.7 Force majeure</h3>
          <p>We are not liable for any failure or delay caused by events beyond our reasonable control, including outages of third-party providers, internet failures, natural disasters, war, or government action.</p>

          <h3 className={styles.h3}>15.8 Language</h3>
          <p>These Terms are written in English. Any translation is provided for convenience; the English version controls in case of conflict.</p>
        </section>

        <section className={styles.section} id="contact">
          <h2 className={styles.h2}>16. Contact</h2>
          <p>For questions about these Terms, write to <strong>[CONTACT_EMAIL]</strong>.</p>
          <p>For formal legal notice: <strong>[YOUR_MAILING_ADDRESS]</strong>.</p>
        </section>

        <div className={styles.footer}>
          <span className={styles.footerCopy}>© 2026 [YOUR_LEGAL_NAME]. All rights reserved.</span>
          <div className={styles.footerLinks}>
            <Link href="/privacy" className={styles.footerLink}>Privacy</Link>
            <Link href="/" className={styles.footerLink}>Home</Link>
          </div>
        </div>
      </div>
    </main>
  );
}
