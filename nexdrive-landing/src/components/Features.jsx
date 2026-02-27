import { useEffect, useState, useRef, useLayoutEffect } from 'react';
import gsap from 'gsap';
import { MousePointer2, GitCommitHorizontal, Crosshair } from 'lucide-react';

export default function Features() {
    const container = useRef(null);

    useLayoutEffect(() => {
        let ctx = gsap.context(() => {
            gsap.from('.feature-card', {
                y: 60,
                opacity: 0,
                duration: 1,
                stagger: 0.15,
                ease: 'power3.out',
                scrollTrigger: {
                    trigger: container.current,
                    start: 'top 70%',
                }
            });
        }, container);
        return () => ctx.revert();
    }, []);

    return (
        <section id="approach" ref={container} className="relative z-20 py-32 px-6 md:px-16 max-w-7xl mx-auto">
            <div className="mb-20 text-center max-w-4xl mx-auto">
                <h2 className="font-heading font-black italic text-4xl md:text-6xl text-white mb-6 drop-shadow-md">What We <span className="text-accent">Train</span></h2>
                <p className="text-white/60 text-lg md:text-xl leading-relaxed">
                    You learn <span className="text-accent">judgment</span>—reading the road, understanding decisions, and recognizing patterns for safe driving.
                </p>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                <DiagnosticShuffler />
                <TelemetryTypewriter />
                <CursorProtocolScheduler />
            </div>
        </section>
    );
}

// Card 1
function DiagnosticShuffler() {
    const [items, setItems] = useState([
        { id: 1, label: "Real Roads", sub: "Actual driving situations." },
        { id: 2, label: "Scenario Analysis", sub: "Evaluating current variables." },
        { id: 3, label: "Judgment Applied", sub: "Making decisions on logic, not rules." }
    ]);

    useEffect(() => {
        const interval = setInterval(() => {
            setItems(prev => {
                const newItems = [...prev];
                const last = newItems.pop();
                newItems.unshift(last);
                return newItems;
            });
        }, 3000);
        return () => clearInterval(interval);
    }, []);

    return (
        <div className="feature-card bg-primary border-t border-l border-white/10 border-b-2 border-r-2 border-b-blue/30 border-r-blue/30 rounded-[2rem] p-8 h-[28rem] flex flex-col relative overflow-hidden shadow-[10px_10px_30px_rgba(0,0,0,0.5)]">
            <div className="flex items-center gap-2 text-blue mb-8">
                <Crosshair size={20} className="text-accent" />
                <span className="font-data text-xs uppercase tracking-wider text-blue font-semibold">Real Skills</span>
            </div>

            <div className="relative flex-1">
                {items.map((item, index) => (
                    <div
                        key={item.id}
                        className="absolute top-0 left-0 w-full bg-slate border border-white/10 rounded-2xl p-6 transition-all duration-[800ms] ease-[cubic-bezier(0.34,1.56,0.64,1)]"
                        style={{
                            transform: `translateY(${index * 20}px) scale(${1 - index * 0.05})`,
                            opacity: 1 - index * 0.2,
                            zIndex: 10 - index
                        }}
                    >
                        <h3 className="font-heading font-semibold text-white/90 text-lg">{item.label}</h3>
                        <p className="font-data text-xs text-white/50 mt-2">{item.sub}</p>
                    </div>
                ))}
            </div>

            <div className="mt-auto pt-6 border-t border-white/10">
                <h4 className="font-heading font-bold text-xl text-white mb-2">Reading the road.</h4>
                <p className="text-sm text-white/60">You learn judgment—understanding decisions and recognizing patterns for safe driving.</p>
            </div>
        </div>
    );
}

// Card 2
function TelemetryTypewriter() {
    const text = "> Explaining the Why...\n> Making connections...\n> Understanding sticks.\n> Rules fade.";
    const [displayed, setDisplayed] = useState("");
    const [index, setIndex] = useState(0);

    useEffect(() => {
        if (index < text.length) {
            const timeout = setTimeout(() => {
                setDisplayed(prev => prev + text.charAt(index));
                setIndex(index + 1);
            }, Math.random() * 50 + 20);
            return () => clearTimeout(timeout);
        } else {
            const timeout = setTimeout(() => {
                setDisplayed("");
                setIndex(0);
            }, 5000);
            return () => clearTimeout(timeout);
        }
    }, [index, text]);

    return (
        <div className="feature-card bg-primary border-t border-l border-white/10 border-b-2 border-r-2 border-b-blue/30 border-r-blue/30 rounded-[2rem] p-8 h-[28rem] flex flex-col relative overflow-hidden shadow-[10px_10px_30px_rgba(0,0,0,0.5)] group">
            <div className="flex items-center justify-between mb-8">
                <div className="flex items-center gap-2 text-blue font-semibold">
                    <GitCommitHorizontal size={20} className="text-accent" />
                    <span className="font-data text-xs uppercase tracking-wider">Real Confidence</span>
                </div>
                <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-accent animate-pulse"></div>
                    <span className="font-data text-[10px] text-accent/80 uppercase">Live Feed</span>
                </div>
            </div>

            <div className="flex-1 bg-black/60 rounded-xl p-6 font-data text-sm text-accent whitespace-pre-wrap overflow-hidden border border-white/5 shadow-inner">
                {displayed}<span className="inline-block w-2 bg-accent ml-1 animate-pulse">&nbsp;</span>
            </div>

            <div className="mt-auto pt-6 border-t border-white/10">
                <h4 className="font-heading font-bold text-xl text-white mb-2">Confidence from understanding.</h4>
                <p className="text-sm text-white/60">When you know *why* you're doing something, you drive with absolute certainty.</p>
            </div>
        </div>
    );
}

// Card 3
function CursorProtocolScheduler() {
    const cursorRef = useRef(null);

    useLayoutEffect(() => {
        let ctx = gsap.context(() => {
            const tl = gsap.timeline({ repeat: -1, repeatDelay: 1 });
            tl.to(cursorRef.current, { x: 40, y: 50, duration: 1, ease: 'power2.inOut' })
                .to(cursorRef.current, { scale: 0.8, duration: 0.1, yoyo: true, repeat: 1 })
                .to('.highlight-cell', { backgroundColor: '#8cc63f', color: '#030811', duration: 0.3 }, "-=0.2")
                .to(cursorRef.current, { x: 120, y: 140, duration: 1, ease: 'power2.inOut', delay: 0.5 })
                .to(cursorRef.current, { scale: 0.8, duration: 0.1, yoyo: true, repeat: 1 })
                .to('.save-btn', { backgroundColor: '#025ca5', color: '#fff', scale: 0.95, duration: 0.1, yoyo: true, repeat: 1 }, "-=0.1")
                .to(cursorRef.current, { opacity: 0, duration: 0.3, delay: 0.5 })
                .set(cursorRef.current, { x: 0, y: 0, opacity: 1 })
                .set('.highlight-cell', { backgroundColor: 'transparent', color: 'rgba(255,255,255,0.4)', delay: 0.5 });
        });
        return () => ctx.revert();
    }, []);

    const days = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

    return (
        <div className="feature-card bg-primary border-t border-l border-white/10 border-b-2 border-r-2 border-b-blue/30 border-r-blue/30 rounded-[2rem] p-8 h-[28rem] flex flex-col relative overflow-hidden shadow-[10px_10px_30px_rgba(0,0,0,0.5)]">
            <div className="flex items-center gap-2 text-blue font-semibold mb-8">
                <MousePointer2 size={20} className="text-accent" />
                <span className="font-data text-xs uppercase tracking-wider">Deliberate Practice</span>
            </div>

            <div className="flex-1 flex flex-col items-center justify-center relative">
                <div className="grid grid-cols-7 gap-2 w-full max-w-[200px] mb-6 relative">
                    {days.map((d, i) => (
                        <div key={i} className={`aspect-square rounded border border-white/10 flex items-center justify-center font-data text-xs text-white/40 transition-colors ${i === 3 ? 'highlight-cell' : ''}`}>
                            {d}
                        </div>
                    ))}
                    <div
                        ref={cursorRef}
                        className="absolute top-[-10px] left-[10px] z-10 text-white drop-shadow-md pointer-events-none"
                    >
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m3 3 7.07 16.97 2.51-7.39 7.39-2.51L3 3z" /><path d="m13 13 6 6" /></svg>
                    </div>
                </div>
                <div className="save-btn px-6 py-2 rounded-full border border-white/20 text-xs font-heading font-semibold text-white/70 transition-colors">
                    Target Specific Gaps
                </div>
            </div>

            <div className="mt-auto pt-6 border-t border-white/10">
                <h4 className="font-heading font-bold text-xl text-white mb-2">Every lesson builds.</h4>
                <p className="text-sm text-white/60">Every lesson targets specific skill gaps. Every hour trains something real.</p>
            </div>
        </div>
    );
}
