export default function CTA() {
  return (
    <section id="investment" className="relative py-32 px-6 md:px-16 bg-[#0a0a0f] text-center">
      <div className="max-w-3xl mx-auto mb-16">
        <h2 className="font-heading font-black italic text-4xl md:text-5xl text-white mb-6">
          The Math of <span className="text-blue">Mastery</span>
        </h2>
        <p className="font-light text-xl text-white/60 leading-relaxed">
          Ineffective instruction is a false economy. Low-cost lessons often lead to more hours,
          repeated tests, and higher long-term risk. NexDrive is a high-yield investment in a
          40-year legacy of safe, confident driving.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8 max-w-6xl mx-auto items-center">

        {/* Standard Training */}
        <div className="bg-slate/20 border border-white/5 rounded-3xl p-8 text-left text-white/50 relative">
          <div className="absolute top-0 right-0 p-6 opacity-20 text-data text-6xl">01</div>
          <h3 className="font-heading font-semibold text-2xl mb-2 text-white/70">Standard Training</h3>
          <p className="text-data text-xs uppercase tracking-widest mb-8 text-white/40">The False Economy</p>
          <ul className="space-y-4 font-light mb-8">
            {[
              'Passive observation',
              'Test-route memorisation',
            ].map((item) => (
              <li key={item} className="flex items-center gap-3">
                <div className="w-1.5 h-1.5 rounded-full bg-red-500/50 shrink-0" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
          <div className="pt-6 border-t border-white/10 text-data opacity-50 text-sm">
            Outcome: Undefined
          </div>
        </div>

        {/* NexDrive — featured */}
        <div className="bg-primary border-2 border-blue rounded-[2.5rem] p-10 text-left relative md:scale-105 shadow-[0_0_50px_rgba(2,92,165,0.15)] z-10">
          <div className="absolute -top-4 right-10 bg-blue text-white px-4 py-1 rounded-full font-heading font-bold text-sm">
            Optimal ROI
          </div>
          <h3 className="font-heading font-semibold text-3xl mb-2 text-white">The NexDrive Investment</h3>
          <p className="text-data text-xs uppercase tracking-widest mb-8 text-accent">The True Investment</p>
          <ul className="space-y-4 font-light text-white/80 mb-10">
            {[
              'Active Co-Lesson Parent Coaching',
              'Focus on high-level roadcraft',
            ].map((item) => (
              <li key={item} className="flex items-center gap-3">
                <div className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
          <div className="pt-6 border-t border-blue/30 text-data text-accent text-sm mb-8">
            Outcome: Verified Competence
          </div>
          <a
            href="mailto:rob@nexdriveacademy.com.au"
            className="btn-magnetic w-full bg-blue text-white py-4 rounded-xl font-heading font-bold text-lg hover:shadow-[0_0_20px_rgba(2,92,165,0.3)] flex items-center justify-center"
          >
            Book a Lesson
          </a>
        </div>

        {/* Lifetime Yield */}
        <div className="bg-slate/20 border border-white/5 rounded-3xl p-8 text-left text-white/50 relative">
          <div className="absolute top-0 right-0 p-6 opacity-20 text-data text-6xl">03</div>
          <h3 className="font-heading font-semibold text-2xl mb-2 text-white/70">The Lifetime Yield</h3>
          <p className="text-data text-xs uppercase tracking-widest mb-8 text-white/40">Long-Term Value</p>
          <ul className="space-y-4 font-light mb-8">
            {[
              'Reduced accident risk',
              'Deep-rooted situational confidence',
            ].map((item) => (
              <li key={item} className="flex items-center gap-3">
                <div className="w-1.5 h-1.5 rounded-full bg-white/30 shrink-0" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
          <div className="pt-6 border-t border-white/10 text-data opacity-50 text-sm">
            Outcome: 40+ years of safe driving
          </div>
        </div>

      </div>
    </section>
  );
}
