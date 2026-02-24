export default function CTA() {
    return (
        <section id="investment" className="relative py-32 px-6 md:px-16 bg-[#0a0a0f] text-center">
            <div className="max-w-3xl mx-auto mb-16">
                <h2 className="font-heading font-black italic text-4xl md:text-5xl text-white mb-6">The Math of Real <span className="text-blue">Training</span></h2>
                <p className="font-light text-xl text-white/60 leading-relaxed">
                    Real training costs a little more per hour. However, real results with quality instruction means fewer paid instructor hours. And with a higher skill level comes a lower risk of accidents. Poor instruction is a false economy.
                </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8 max-w-6xl mx-auto items-center">
                {/* Standard Route */}
                <div className="bg-slate/20 border border-white/5 rounded-3xl p-8 text-left text-white/50 relative">
                    <div className="absolute top-0 right-0 p-6 opacity-20 font-data text-6xl">01</div>
                    <h3 className="font-heading font-semibold text-2xl mb-2 text-white/70">Standard Schools</h3>
                    <p className="font-data text-xs uppercase tracking-widest mb-8 text-white/40">The False Economy</p>
                    <ul className="space-y-4 font-light mb-8">
                        <li className="flex items-center gap-3">
                            <div className="w-1.5 h-1.5 rounded-full bg-red-500/50"></div>
                            <span>40-60+ paid instructor hours</span>
                        </li>
                        <li className="flex items-center gap-3">
                            <div className="w-1.5 h-1.5 rounded-full bg-red-500/50"></div>
                            <span>Passive observation by parents</span>
                        </li>
                        <li className="flex items-center gap-3">
                            <div className="w-1.5 h-1.5 rounded-full bg-red-500/50"></div>
                            <span>Focus on passing the test route</span>
                        </li>
                    </ul>
                    <div className="pt-6 border-t border-white/10 font-data opacity-50 text-sm mt-auto">
                        System Outcome: Undefined
                    </div>
                </div>

                {/* NexDrive Route (Middle Pop) */}
                <div className="bg-primary border-2 border-blue rounded-[2.5rem] p-10 text-left relative transform md:scale-105 shadow-[0_0_50px_rgba(2,92,165,0.15)] z-10">
                    <div className="absolute -top-4 right-10 bg-blue text-white px-4 py-1 rounded-full font-heading font-bold text-sm">
                        Optimal ROI
                    </div>
                    <h3 className="font-heading font-semibold text-3xl mb-2 text-white">NexDrive Academy</h3>
                    <p className="font-data text-xs uppercase tracking-widest mb-8 text-accent">The True Investment</p>
                    <ul className="space-y-4 font-light text-white/80 mb-10">
                        <li className="flex items-center gap-3">
                            <div className="w-1.5 h-1.5 rounded-full bg-accent"></div>
                            <span>Typically 25-35 optimized hours</span>
                        </li>
                        <li className="flex items-center gap-3">
                            <div className="w-1.5 h-1.5 rounded-full bg-accent"></div>
                            <span>Co-Lesson Parent Coaching included</span>
                        </li>
                        <li className="flex items-center gap-3">
                            <div className="w-1.5 h-1.5 rounded-full bg-accent"></div>
                            <span>Focus on lifetime judgment skills</span>
                        </li>
                    </ul>
                    <button className="w-full btn-magnetic bg-blue text-white py-4 rounded-xl font-heading font-bold text-lg hover:shadow-[0_0_20px_rgba(2,92,165,0.3)]">
                        Book a Lesson
                    </button>
                </div>

                {/* Future Value */}
                <div className="bg-slate/20 border border-white/5 rounded-3xl p-8 text-left text-white/50 relative">
                    <div className="absolute top-0 right-0 p-6 opacity-20 font-data text-6xl">03</div>
                    <h3 className="font-heading font-semibold text-2xl mb-2 text-white/70">The Lifetime Yield</h3>
                    <p className="font-data text-xs uppercase tracking-widest mb-8 text-white/40">Long Term Value</p>
                    <ul className="space-y-4 font-light mb-8">
                        <li className="flex items-center gap-3">
                            <div className="w-1.5 h-1.5 rounded-full bg-white/30"></div>
                            <span>Reduced long-term accident risk</span>
                        </li>
                        <li className="flex items-center gap-3">
                            <div className="w-1.5 h-1.5 rounded-full bg-white/30"></div>
                            <span>Deep-rooted situational confidence</span>
                        </li>
                        <li className="flex items-center gap-3">
                            <div className="w-1.5 h-1.5 rounded-full bg-white/30"></div>
                            <span>A skillset built for 40+ years</span>
                        </li>
                    </ul>
                    <div className="pt-6 border-t border-white/10 font-data opacity-50 text-sm mt-auto">
                        System Outcome: Verified Confidence
                    </div>
                </div>
            </div>
        </section>
    );
}
