import { useLayoutEffect, useRef } from 'react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

const steps = [
    {
        num: "01",
        title: "Real Roads",
        desc: "You encounter different decisions and learn pattern recognition for actual driving situations.",
        vizType: "rotate"
    },
    {
        num: "02",
        title: "The Why",
        desc: "Not just 'do this'. Here's why. Here's when. Understanding sticks. Rules fade.",
        vizType: "scan"
    },
    {
        num: "03",
        title: "Deliberate Practice",
        desc: "Every lesson targets specific skill gaps. Every hour trains something real.",
        vizType: "pulse"
    }
];

export default function Protocol() {
    const container = useRef(null);

    useLayoutEffect(() => {
        let ctx = gsap.context(() => {
            const cards = gsap.utils.toArray('.stack-card');

            cards.forEach((card, i) => {
                if (i === cards.length - 1) return;

                ScrollTrigger.create({
                    trigger: card,
                    start: 'top top+=100', // When card reaches 100px from top
                    endTrigger: container.current,
                    end: 'bottom bottom',
                    pin: true,
                    pinSpacing: false,
                    scrub: true,
                    animation: gsap.to(card, {
                        scale: 0.9,
                        opacity: 0.3,
                        filter: 'blur(10px)',
                        ease: 'none'
                    })
                });
            });

            // Specific Visual Animations
            gsap.to('.viz-rotate', { rotation: 360, duration: 20, repeat: -1, ease: 'linear' });
            gsap.to('.viz-scan', { y: 100, duration: 2, repeat: -1, yoyo: true, ease: 'power1.inOut' });
            gsap.to('.viz-pulse', { strokeDashoffset: 0, duration: 2, repeat: -1, ease: 'power2.out' });

        }, container);
        return () => ctx.revert();
    }, []);

    return (
        <section id="protocol" ref={container} className="relative bg-primary py-24 pb-[30vh]">
            <div className="max-w-4xl mx-auto px-6 mb-24 text-center">
                <h2 className="font-heading font-black italic text-4xl md:text-5xl text-white mb-4">The Methodology</h2>
                <p className="text-white/60 font-light text-xl">How we train real skills.</p>
            </div>

            <div className="relative max-w-5xl mx-auto px-6">
                {steps.map((step, i) => (
                    <div
                        key={i}
                        className="stack-card bg-slate border border-white/5 p-12 md:p-16 rounded-[3rem] shadow-2xl mb-[10vh] min-h-[60vh] flex flex-col md:flex-row items-center justify-between gap-12 relative overflow-hidden"
                        style={{ zIndex: i + 1 }}
                    >
                        {/* Background ambient glow */}
                        <div className="absolute top-0 right-0 w-96 h-96 bg-accent opacity-5 blur-[120px] rounded-full pointer-events-none"></div>

                        <div className="flex-1 z-10">
                            <span className="font-data text-accent text-lg md:text-2xl mb-4 block">[{step.num}]</span>
                            <h3 className="font-heading font-bold text-4xl md:text-6xl text-white mb-6 tracking-tight">{step.title}</h3>
                            <p className="font-light text-xl text-white/60 leading-relaxed max-w-sm">{step.desc}</p>
                        </div>

                        <div className="relative w-full md:w-1/2 aspect-square max-w-sm flex items-center justify-center bg-primary/30 rounded-full border border-white/5 p-8 z-10">
                            {step.vizType === 'rotate' && (
                                <div className="viz-rotate w-full h-full border-4 border-dashed border-accent/40 rounded-full flex items-center justify-center">
                                    <div className="w-2/3 h-2/3 border border-white/20 rounded-full" />
                                </div>
                            )}
                            {step.vizType === 'scan' && (
                                <div className="w-full h-full relative border border-white/10 overflow-hidden bg-black/20">
                                    <div className="viz-scan w-full h-1 bg-accent absolute top-8 shadow-[0_0_15px_rgba(201,168,76,0.8)]" />
                                    <div className="grid grid-cols-5 gap-2 opacity-20 p-4 h-full">
                                        {Array(25).fill(0).map((_, idx) => <div key={idx} className="bg-white rounded-sm" />)}
                                    </div>
                                </div>
                            )}
                            {step.vizType === 'pulse' && (
                                <svg className="w-full h-full" viewBox="0 0 100 100" fill="none" stroke="currentColor">
                                    <path
                                        className="viz-pulse text-accent"
                                        strokeWidth="2"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeDasharray="200"
                                        strokeDashoffset="200"
                                        d="M 10 50 L 30 50 L 40 20 L 60 80 L 70 50 L 90 50"
                                    />
                                </svg>
                            )}
                        </div>
                    </div>
                ))}
            </div>
        </section>
    );
}
