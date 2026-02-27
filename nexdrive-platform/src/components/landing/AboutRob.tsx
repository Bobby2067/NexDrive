export default function AboutRob() {
  const credentials = [
    { label: '20+', sub: 'Years Instructing' },
    { label: 'Top 10', sub: 'National Rally Results' },
    { label: 'P5', sub: 'Sandown 500 Outright' },
    { label: 'ADI', sub: 'Certified Instructor' },
  ];

  const disciplines = [
    { title: 'Learner Driver Instruction', desc: 'Foundational through to licence-ready. CBT&A compliant across all 23 competency tasks.' },
    { title: 'Advanced & Defensive Driving', desc: 'Hazard anticipation, situational awareness, and high-performance vehicle control.' },
    { title: 'AAMI Defensive Driving', desc: 'Certified instructor — crash-avoidance and risk-reduction for everyday motorists.' },
    { title: 'Co-Lesson Parent Coaching', desc: 'Training the people training your learner. Turning supervision hours into real skill development.' },
  ];

  return (
    <section id="about" className="relative py-32 px-6 md:px-16 bg-primary overflow-hidden">
      {/* Subtle background glow */}
      <div className="absolute top-0 right-0 w-[600px] h-[600px] bg-blue/5 rounded-full blur-[120px] pointer-events-none" />

      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-20">
          <span className="text-data text-xs uppercase tracking-[0.25em] text-accent">Your Instructor</span>
          <h2 className="font-heading font-black italic text-4xl md:text-6xl text-white mt-4">
            Rob Ogilvie
          </h2>
          <p className="text-white/50 text-xl font-light mt-3 max-w-2xl">
            20+ years on the road. National-level motorsport. A genuine commitment to building drivers who last a lifetime.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 items-start">
          {/* Left — credentials + bio */}
          <div>
            {/* Stat row */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-12">
              {credentials.map((c) => (
                <div key={c.label} className="bg-slate/30 border border-white/5 rounded-2xl p-5 text-center">
                  <div className="font-heading font-black text-3xl text-white mb-1">{c.label}</div>
                  <div className="text-data text-[10px] uppercase tracking-wider text-white/40">{c.sub}</div>
                </div>
              ))}
            </div>

            {/* Bio */}
            <div className="space-y-5 text-white/65 font-light text-lg leading-relaxed">
              <p>
                Most driving instructors know the rules. Rob Ogilvie knows what it actually feels like to drive at the limit — 
                and how to bring that understanding back to the road for every student.
              </p>
              <p>
                With multiple years competing at the top tier of Australian rally, a 5th place outright at the Sandown 500, 
                and competition in the Australian Production Car Championship, Rob brings a level of real-world vehicle 
                mastery that simply cannot be replicated in a classroom.
              </p>
              <p>
                That experience — knowing exactly what the car is doing and why — is what Rob teaches. 
                Not just the rules. The judgment behind the rules.
              </p>
            </div>

            {/* Motorsport badge */}
            <div className="mt-10 inline-flex items-center gap-4 border border-blue/20 bg-blue/5 rounded-2xl px-6 py-4">
              <div className="w-2 h-2 rounded-full bg-accent animate-pulse shrink-0" />
              <p className="text-data text-xs text-white/60 uppercase tracking-wider">
                National Rally · Sandown 500 · Australian Production Car Championship
              </p>
            </div>
          </div>

          {/* Right — discipline cards */}
          <div className="space-y-4">
            {disciplines.map((d, i) => (
              <div
                key={i}
                className="group bg-slate/20 border border-white/5 hover:border-blue/20 rounded-2xl p-6 transition-all duration-300 hover:bg-slate/40"
              >
                <div className="flex items-start gap-4">
                  <div className="text-data text-accent text-xs mt-1 shrink-0">[{String(i + 1).padStart(2, '0')}]</div>
                  <div>
                    <h4 className="font-heading font-bold text-white text-lg mb-1">{d.title}</h4>
                    <p className="text-white/50 text-sm font-light leading-relaxed">{d.desc}</p>
                  </div>
                </div>
              </div>
            ))}

            {/* CTA */}
            <div className="pt-4">
              <a
                href="#investment"
                className="inline-flex items-center gap-3 text-accent font-heading font-semibold hover:gap-5 transition-all duration-300"
              >
                Book a lesson with Rob
                <span className="text-lg">→</span>
              </a>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
