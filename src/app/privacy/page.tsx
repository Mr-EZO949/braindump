import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import styles from "../legal.module.css";

export const metadata: Metadata = {
  title: "Privacy Policy · BrainDump",
  description: "How BrainDump collects, uses, and protects your information.",
};

export default function PrivacyPolicyPage() {
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
          <h1 className={styles.title}>Privacy Policy</h1>
          <p className={styles.effective}>Effective: 14 May 2026 · Last updated: 14 May 2026</p>

          <p className={styles.lede}>
            BrainDump (&ldquo;we,&rdquo; &ldquo;us&rdquo;) is operated by Zhangir Ospan.
            This policy explains what personal information we collect when you use our website
            and app (the &ldquo;Service&rdquo;), what we do with it, and the rights you have over it.
            We try to write this in plain English &mdash; but where the law requires us to be precise, we are.
          </p>

          <div className={styles.toc}>
            <span className={styles.tocTitle}>Contents</span>
            <ol className={styles.tocList}>
              <li><a href="#info-we-collect">Information we collect</a></li>
              <li><a href="#how-we-use">How we use information</a></li>
              <li><a href="#legal-bases">Legal bases (EEA / UK users)</a></li>
              <li><a href="#ai-processing">AI processing &amp; subprocessors</a></li>
              <li><a href="#sharing">When we share information</a></li>
              <li><a href="#retention">Data retention</a></li>
              <li><a href="#security">Security</a></li>
              <li><a href="#your-rights">Your privacy rights</a></li>
              <li><a href="#california">California residents (CCPA / CPRA)</a></li>
              <li><a href="#eea-uk">EEA / UK residents (GDPR)</a></li>
              <li><a href="#international-transfers">International data transfers</a></li>
              <li><a href="#cookies">Cookies &amp; local storage</a></li>
              <li><a href="#children">Children</a></li>
              <li><a href="#changes">Changes to this policy</a></li>
              <li><a href="#contact">Contact us</a></li>
            </ol>
          </div>
        </header>

        <section className={styles.section} id="info-we-collect">
          <h2 className={styles.h2}>1. Information we collect</h2>

          <h3 className={styles.h3}>Information you give us</h3>
          <ul>
            <li><strong>Account information.</strong> When you create an account, we collect your email address and a hashed password. We do not store your password in plaintext.</li>
            <li><strong>Your content.</strong> Everything you put into BrainDump &mdash; brain dumps, tasks, habits, goals, ideas, journal entries, chats with the assistant, planner schedules, weekly reflections. This is the core of what the Service does, and it is yours.</li>
            <li><strong>Waitlist information.</strong> If you join the waitlist before having an account, we collect your email address and the page or campaign that referred you.</li>
            <li><strong>Communications.</strong> If you email us for support or send us feedback, we keep that correspondence.</li>
          </ul>

          <h3 className={styles.h3}>Information we collect automatically</h3>
          <ul>
            <li><strong>Log data.</strong> IP address, browser type, device type, operating system, pages visited, timestamps, and referrers. This is standard server log data and is used for security, debugging, and basic analytics.</li>
            <li><strong>Usage data.</strong> Aggregated metrics about how you use the Service &mdash; e.g. how many nodes you create, which features you use &mdash; so we can improve it.</li>
            <li><strong>Cookies &amp; local storage.</strong> See <a href="#cookies">Cookies &amp; local storage</a> below.</li>
          </ul>

          <h3 className={styles.h3}>Information we derive</h3>
          <ul>
            <li><strong>Embeddings.</strong> We send your node titles and summaries to embedding providers (see <a href="#ai-processing">AI processing</a>) and store the resulting numeric vectors. These vectors power semantic search and clustering. They are derived from your content but are not human-readable.</li>
            <li><strong>AI-generated metadata.</strong> When you brain dump, an AI model proposes structured nodes from your text (titles, types, summaries, importance scores). You review and accept these before they enter your workspace.</li>
          </ul>
        </section>

        <section className={styles.section} id="how-we-use">
          <h2 className={styles.h2}>2. How we use information</h2>
          <p>We use information for the following purposes:</p>
          <ul>
            <li><strong>To run the Service.</strong> Authenticate you, save your data, sync across devices, send the assistant&apos;s answers, run the planner, generate weekly reflections.</li>
            <li><strong>AI features.</strong> Send your content to third-party AI providers so they can return extractions, embeddings, suggestions, summaries, and chat responses. See <a href="#ai-processing">AI processing</a> for who receives what.</li>
            <li><strong>Account management.</strong> Verify your email, reset your password, notify you of account changes.</li>
            <li><strong>Support &amp; communication.</strong> Respond to your questions, send service announcements, and (if you opt in) send product updates.</li>
            <li><strong>Improving the Service.</strong> Analyze aggregated, de-identified usage data to find bugs, improve performance, and prioritize features.</li>
            <li><strong>Security &amp; abuse prevention.</strong> Detect unauthorized access, fraud, scraping, and other abuse.</li>
            <li><strong>Legal compliance.</strong> Comply with valid legal requests and enforce our Terms.</li>
          </ul>
          <div className={styles.callout}>
            <p>
              <strong>We do not sell your personal information.</strong> We do not show third-party advertising in the Service. We do not use your content to train our own AI models, and we contractually require our AI subprocessors not to use your content to train theirs.
            </p>
          </div>
        </section>

        <section className={styles.section} id="legal-bases">
          <h2 className={styles.h2}>3. Legal bases (EEA / UK users)</h2>
          <p>If you are in the European Economic Area or the United Kingdom, we process your personal data under the following legal bases:</p>
          <ul>
            <li><strong>Contract</strong> (Art. 6(1)(b) GDPR): processing necessary to provide the Service you signed up for &mdash; storing your content, running AI features, syncing your devices.</li>
            <li><strong>Legitimate interests</strong> (Art. 6(1)(f) GDPR): security, fraud prevention, abuse detection, and basic product analytics. You can object at any time.</li>
            <li><strong>Consent</strong> (Art. 6(1)(a) GDPR): optional marketing emails. You can withdraw consent at any time by clicking &ldquo;unsubscribe.&rdquo;</li>
            <li><strong>Legal obligation</strong> (Art. 6(1)(c) GDPR): when we must process data to comply with law.</li>
          </ul>
        </section>

        <section className={styles.section} id="ai-processing">
          <h2 className={styles.h2}>4. AI processing &amp; subprocessors</h2>
          <p>
            BrainDump is an AI-native product. To deliver its features, your content is sent to third-party AI providers (&ldquo;subprocessors&rdquo;) over secure connections. We list every one of them here, what they process, and why.
          </p>

          <h3 className={styles.h3}>Subprocessors</h3>
          <ul>
            <li>
              <strong>Supabase, Inc.</strong> &mdash; hosts our primary database and authentication. Stores your account, content, and all derived data. <a href="https://supabase.com/privacy" target="_blank" rel="noopener noreferrer">Privacy policy</a>.
            </li>
            <li>
              <strong>Anthropic, PBC</strong> &mdash; processes your brain dump text, node content, and chat messages to extract structure, answer questions, suggest next steps, and run other AI features. Anthropic states it does not use API inputs or outputs to train its models. <a href="https://www.anthropic.com/legal/privacy" target="_blank" rel="noopener noreferrer">Privacy policy</a>.
            </li>
            <li>
              <strong>Google LLC (Generative AI / Gemini)</strong> &mdash; generates vector embeddings of your node titles and summaries so we can power semantic search and clustering. We use the paid API tier, under which Google states inputs and outputs are not used to train its models. <a href="https://policies.google.com/privacy" target="_blank" rel="noopener noreferrer">Privacy policy</a>.
            </li>
            <li>
              <strong>Cohere Inc.</strong> &mdash; (where applicable) reranks search results and assists with clustering. <a href="https://cohere.com/privacy" target="_blank" rel="noopener noreferrer">Privacy policy</a>.
            </li>
            <li>
              <strong>Vercel Inc.</strong> &mdash; hosts the application and its edge functions; receives standard server logs (IP, request metadata). <a href="https://vercel.com/legal/privacy-policy" target="_blank" rel="noopener noreferrer">Privacy policy</a>.
            </li>
          </ul>

          <div className={styles.callout}>
            <p>
              <strong>What this means in practice.</strong> When you brain dump, the text leaves our servers and is sent to Anthropic to be processed; the result comes back and is stored in your account on Supabase. The same applies to embedding generation (Google) and reranking (Cohere). These providers process your content on our behalf under data processing agreements; they do not have their own relationship with you.
            </p>
          </div>
        </section>

        <section className={styles.section} id="sharing">
          <h2 className={styles.h2}>5. When we share information</h2>
          <p>We share personal information only in the following circumstances:</p>
          <ul>
            <li><strong>Subprocessors.</strong> The third-party service providers listed above, who process data on our behalf to deliver the Service.</li>
            <li><strong>Legal requests.</strong> When required by law, valid legal process, or to protect the rights, property, or safety of BrainDump, our users, or others.</li>
            <li><strong>Business transfers.</strong> If we are acquired, merged, or sold, your data may transfer to the new owner under the same protections this policy describes.</li>
            <li><strong>With your consent.</strong> Anything else only with your explicit consent.</li>
          </ul>
        </section>

        <section className={styles.section} id="retention">
          <h2 className={styles.h2}>6. Data retention</h2>
          <ul>
            <li><strong>Account &amp; content.</strong> We keep your account and content as long as your account is active.</li>
            <li><strong>Account deletion.</strong> When you delete your account, we delete your content from our active systems within <strong>30 days</strong>. Encrypted backups may retain copies for up to <strong>90 days</strong> after deletion before being overwritten.</li>
            <li><strong>Waitlist data.</strong> We keep waitlist emails until launch, after which we either transition you to an account or delete the entry within <strong>12 months</strong>.</li>
            <li><strong>Logs.</strong> Standard server logs are retained for up to <strong>30 days</strong> for security and debugging.</li>
            <li><strong>Legal &amp; financial records.</strong> Where law requires (e.g. tax records), we keep records for the required period.</li>
          </ul>
        </section>

        <section className={styles.section} id="security">
          <h2 className={styles.h2}>7. Security</h2>
          <p>We take reasonable technical and organizational measures to protect your information:</p>
          <ul>
            <li>TLS encryption in transit between you, our servers, and our subprocessors.</li>
            <li>At-rest encryption of the database (provided by Supabase).</li>
            <li>Passwords are hashed; we never see or store the plaintext.</li>
            <li>Row-level security on our database so users can only access their own content.</li>
            <li>Restricted internal access to production data, audited via service-role credentials.</li>
          </ul>
          <p>
            No method of transmission or storage is 100% secure. If we become aware of a breach affecting your personal data, we will notify you and the appropriate regulators in accordance with applicable law.
          </p>
        </section>

        <section className={styles.section} id="your-rights">
          <h2 className={styles.h2}>8. Your privacy rights</h2>
          <p>Regardless of where you live, you can:</p>
          <ul>
            <li><strong>Access</strong> the data we hold about you.</li>
            <li><strong>Correct</strong> inaccurate data (most data is editable directly inside the app).</li>
            <li><strong>Delete</strong> your account and all associated content from within the app (Settings &rarr; Delete account), or by emailing us.</li>
            <li><strong>Export</strong> a copy of your content in a machine-readable format by requesting it from us at the email below.</li>
            <li><strong>Opt out</strong> of optional marketing communications.</li>
          </ul>
          <p>To exercise a right that isn&apos;t directly available in the app, email us at <strong>ospanzhangir2005@gmail.com</strong>. We will respond within 30 days.</p>
        </section>

        <section className={styles.section} id="california">
          <h2 className={styles.h2}>9. California residents (CCPA / CPRA)</h2>
          <p>If you live in California, you have additional rights under the California Consumer Privacy Act:</p>
          <ul>
            <li><strong>Right to know</strong> what categories of personal information we collect, why, and who we share it with (we&apos;ve set this out above).</li>
            <li><strong>Right to delete</strong> your personal information, subject to legal exceptions.</li>
            <li><strong>Right to correct</strong> inaccurate information.</li>
            <li><strong>Right to opt out of sale or sharing</strong> for cross-context behavioral advertising. <strong>We do not sell or share personal information for advertising,</strong> so this right is not triggered, but we honor &ldquo;Do Not Sell or Share&rdquo; requests anyway.</li>
            <li><strong>Right to limit use of sensitive information.</strong> We do not use sensitive personal information beyond what is necessary to provide the Service.</li>
            <li><strong>Right to non-discrimination</strong> for exercising any of these rights.</li>
          </ul>
          <p>To exercise these rights, email <strong>ospanzhangir2005@gmail.com</strong>. You may also designate an authorized agent.</p>
        </section>

        <section className={styles.section} id="eea-uk">
          <h2 className={styles.h2}>10. EEA / UK residents (GDPR)</h2>
          <p>If you are in the European Economic Area, the United Kingdom, or Switzerland, you have the rights described in Section 8, plus:</p>
          <ul>
            <li><strong>Right to restrict</strong> processing of your data in certain circumstances.</li>
            <li><strong>Right to object</strong> to processing based on legitimate interests.</li>
            <li><strong>Right to data portability</strong> &mdash; receive your data in a structured, machine-readable format.</li>
            <li><strong>Right to withdraw consent</strong> at any time, where consent is the basis for processing.</li>
            <li><strong>Right to lodge a complaint</strong> with your local data protection authority.</li>
          </ul>
          <p>
            Because we do not have an EU establishment, you may contact our representative for GDPR purposes at the same email above. If we later appoint a formal Article 27 representative, we will list them here.
          </p>
        </section>

        <section className={styles.section} id="international-transfers">
          <h2 className={styles.h2}>11. International data transfers</h2>
          <p>
            Our subprocessors (Anthropic, Google, Supabase, Vercel, Cohere) are primarily based in the United States, and your data is processed there. When we transfer personal data of EEA, UK, or Swiss users to the United States, we rely on:
          </p>
          <ul>
            <li><strong>Standard Contractual Clauses</strong> approved by the European Commission.</li>
            <li><strong>EU-U.S. Data Privacy Framework</strong> and its UK and Swiss extensions, where applicable.</li>
            <li><strong>Supplementary measures</strong> such as encryption in transit and access controls.</li>
          </ul>
        </section>

        <section className={styles.section} id="cookies">
          <h2 className={styles.h2}>12. Cookies &amp; local storage</h2>
          <p>We use a small number of cookies and browser storage items, all strictly functional:</p>
          <ul>
            <li><strong>Authentication cookies.</strong> Set by Supabase to keep you signed in. Essential to the Service.</li>
            <li><strong>Local storage.</strong> Used to remember which workspace you had open, your graph layout, your camera position, and similar UI preferences. This data stays on your device.</li>
            <li><strong>Server logs.</strong> Basic log data described in Section 1.</li>
          </ul>
          <p>We do not use third-party advertising or behavioral-tracking cookies.</p>
        </section>

        <section className={styles.section} id="children">
          <h2 className={styles.h2}>13. Children</h2>
          <p>
            BrainDump is not directed at children. You must be at least <strong>13 years old</strong> to use the Service. If you are in the European Economic Area or the UK, you must be at least <strong>16 years old</strong>, or have verifiable parental consent if you are between 13 and 16.
          </p>
          <p>
            If we learn we have collected personal information from a child without proper consent, we will delete it. If you believe a child has provided us personal information, contact us at <strong>ospanzhangir2005@gmail.com</strong>.
          </p>
        </section>

        <section className={styles.section} id="changes">
          <h2 className={styles.h2}>14. Changes to this policy</h2>
          <p>
            We may update this policy. When we do, we&apos;ll change the &ldquo;Last updated&rdquo; date at the top. For material changes, we&apos;ll notify you in-app or by email at least 30 days before the change takes effect.
          </p>
        </section>

        <section className={styles.section} id="contact">
          <h2 className={styles.h2}>15. Contact us</h2>
          <p>Questions, requests, or complaints? Email us at <strong>ospanzhangir2005@gmail.com</strong>.</p>
          <p>For formal legal notice, email <strong>ospanzhangir2005@gmail.com</strong>.</p>
        </section>

        <div className={styles.footer}>
          <span className={styles.footerCopy}>© 2026 Zhangir Ospan. All rights reserved.</span>
          <div className={styles.footerLinks}>
            <Link href="/terms" className={styles.footerLink}>Terms</Link>
            <Link href="/" className={styles.footerLink}>Home</Link>
          </div>
        </div>
      </div>
    </main>
  );
}
