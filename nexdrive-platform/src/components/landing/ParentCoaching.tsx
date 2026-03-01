import { Download } from 'lucide-react';

export default function ParentCoaching() {
  const pillars = [
    {
      num: '01',
      title: 'Regulate the Cockpit',
      body: 'Your stress is noise that interferes with their learning. A calm environment allows for better cognitive processing. If you feel yourself tensing — take a breath.',
    },
    {
      num: '02',
      title: 'Ask, Don\'t Tell',
      body: 'Instead of "You turned too wide," ask: "What could we have done to make that turn feel more controlled?" This forces the student to debrief their own performance.',
    },
    {
      num: '03',
      title: 'Objective Observation',
      body: 'Remove the good/bad labels. Focus on physics and timing. "We felt a lurch — how can we smooth out that final 5% of braking next time?"',
    },
    {
      num: '04',
      title: 'Validate Pattern Recognition',
      body: 'When they spot a hazard early, acknowledge it. "Great early scan — you saw that cyclist before I did." This reinforces the predictive instincts we\'re building.',
    },
    {
      num: '05',
      title: 'The 1% Rule',
      body: "Don't try to fix everything in one drive. Focus on Micro-Gains. Small, consistent refinements lead to elite-level roadcraft.",
    },
  ];

  const debriefQs = [
    { q: '"What felt the most in control today?"',                                         tag: 'Builds Confidence' },
    { q: '"Was there a moment you felt under pressure? What would have given you more time?"', tag: 'Builds Strategy' },
    { q: '"What\'s the one thing we should refine next drive?"',                           tag: 'Builds Accountability' },
  ];

  return (
    <section id="parent-coaching" className="relative py-32 px-6 md:px-16 bg-primary overflow-hidden">
      {/* Background glow */}
      <div className="absolute bottom-0 left-0 w-[500px] h-[500px] bg-accent/5 rounded-full blur-[120px] pointer-events-none" />

      <div className="max-w-7xl mx-auto">

        {/* ── Header ─────────────────────────────────── */}
        <div className="mb-16 max-w-3xl">
          <span className="text-data text-xs uppercase tracking-[0.25em] text-accent">For Parents & Supervisors</span>
          <h2 className="font-heading font-black italic text-4xl md:text-6xl text-white mt-4 mb-6">
            The Supervisor&apos;s<br />Guide to Roadcraft
          </h2>
          <p className="text-white/50 text-lg font-light leading-relaxed mb-2">
            Most learner progress happens between professional lessons. Your role isn&apos;t to be a{' '}
            <span className="text-white/80 font-medium">&ldquo;human brake pedal&rdquo;</span> — it&apos;s to be a{' '}
            <span className="text-accent font-semibold">Performance Coach</span>.
          </p>
          <p className="text-white/40 text-base font-light">
            Use these principles to build a driver who thinks for themselves.
          </p>
        </div>

        {/* ── Two-column layout ───────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 lg:gap-12 mb-20">

          {/* Left — Five Pillars */}
          <div>
            <p className="text-data text-xs uppercase tracking-[0.25em] text-accent mb-5">
              The Five Coaching Pillars
            </p>
            <div className="space-y-3">
              {pillars.map((p) => (
                <div
                  key={p.num}
                  className="group flex gap-4 bg-slate/30 border border-white/5 hover:border-blue/20 hover:bg-slate/50 rounded-2xl p-5 transition-all duration-300"
                >
                  {/* Number */}
                  <div className="shrink-0 w-10 text-center">
                    <span className="font-heading font-black text-2xl text-blue leading-none">{p.num}</span>
                  </div>
                  {/* Content */}
                  <div>
                    <h4 className="font-heading font-bold text-white text-sm mb-1">{p.title}</h4>
                    <p className="text-white/45 text-sm font-light leading-relaxed">{p.body}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Right — Post-Drive Debrief + CTA */}
          <div className="flex flex-col gap-6">
            {/* Debrief block */}
            <div className="bg-slate/30 border border-white/5 rounded-2xl p-7">
              <p className="text-data text-[10px] uppercase tracking-[0.2em] text-white/30 mb-4">
                The Post-Drive Debrief
              </p>
              <h3 className="font-heading font-bold text-white text-lg mb-5">
                Ask these three questions after every session.
              </h3>
              <div className="space-y-4">
                {debriefQs.map((d, i) => (
                  <div key={i} className="flex items-start gap-4 pb-4 border-b border-white/5 last:border-0 last:pb-0">
                    <span className="font-heading font-black text-blue text-xl shrink-0 leading-none mt-0.5">
                      {i + 1}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-white/80 text-sm font-medium leading-snug mb-1.5">{d.q}</p>
                      <span className="text-data text-[10px] uppercase tracking-wider text-accent">{d.tag}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Download CTA */}
            <a
              href="/NexDrive_Parent_Guide.pdf"
              download="NexDrive_Supervisors_Guide.pdf"
              className="group relative flex items-center justify-between bg-blue/10 hover:bg-blue/20 border border-blue/20 hover:border-blue/40 rounded-2xl p-7 transition-all duration-300 overflow-hidden"
            >
              <div className="absolute inset-0 bg-gradient-to-r from-blue/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
              <div className="relative z-10">
                <p className="text-data text-[10px] uppercase tracking-[0.2em] text-blue mb-2">Free Download</p>
                <h4 className="font-heading font-bold text-white text-lg mb-1">
                  The Full Supervisor&apos;s Guide
                </h4>
                <p className="text-white/40 text-sm font-light">
                  Both pages. Print it. Bring it to every session.
                </p>
              </div>
              <div className="relative z-10 shrink-0 ml-6 w-12 h-12 rounded-full bg-blue/20 border border-blue/30 flex items-center justify-center group-hover:bg-blue/30 transition-colors">
                <Download size={18} className="text-accent group-hover:translate-y-0.5 transition-transform" />
              </div>
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
