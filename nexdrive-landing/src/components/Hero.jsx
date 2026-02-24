import { useLayoutEffect, useRef, useState, useEffect } from 'react';
import gsap from 'gsap';

export default function Hero() {
    const container = useRef(null);
    const [wordIndex, setWordIndex] = useState(0);

    const words = [
        { text: "Skills.", color: "text-white/90" },
        { text: "Confidence.", color: "text-blue drop-shadow-[0_10px_30px_rgba(2,92,165,0.4)]" },
        { text: "Drivers.", color: "text-accent drop-shadow-[0_10px_30px_rgba(140,198,63,0.3)]" }
    ];

    useEffect(() => {
        const interval = setInterval(() => {
            setWordIndex((prev) => (prev + 1) % words.length);
        }, 2200);
        return () => clearInterval(interval);
    }, []);

    useLayoutEffect(() => {
        let ctx = gsap.context(() => {
            gsap.from('.hero-text', {
                y: 40,
                opacity: 0,
                duration: 1.2,
                stagger: 0.15,
                ease: 'power3.out',
                delay: 0.2
            });
            gsap.from('.hero-cta', {
                y: 20,
                opacity: 0,
                duration: 1,
                ease: 'power3.out',
                delay: 0.8
            });
        }, container);
        return () => ctx.revert();
    }, []);

    return (
        <section ref={container} className="relative h-[100dvh] w-full flex items-end pb-24 px-6 md:px-16 overflow-hidden">
            {/* Background Image & Gradient */}
            <div className="absolute inset-0 z-0">
                <img
                    src="https://images.unsplash.com/photo-1469285994282-454ceb49e63c?q=80&w=2000"
                    alt="Cinematic automotive"
                    className="w-full h-full object-cover opacity-60"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-primary via-primary/80 to-transparent"></div>
            </div>

            {/* Content */}
            <div className="relative z-10 max-w-4xl text-left">
                <div className="flex flex-wrap items-center gap-x-4">
                    <span className="hero-text font-heading font-bold text-5xl md:text-7xl lg:text-[6.5rem] tracking-tight text-white/90 py-2">
                        Real
                    </span>
                    <div className="hero-text relative h-[60px] md:h-[90px] lg:h-[130px] overflow-hidden w-[320px] sm:w-[350px] md:w-[480px] lg:w-[650px] shrink-0">
                        <div
                            className="flex flex-col transition-transform duration-700 ease-[cubic-bezier(0.65,0,0.35,1)] absolute inset-0 w-full top-0"
                            style={{ transform: `translateY(-${wordIndex * 100}%)` }}
                        >
                            {words.map((w, i) => (
                                <span
                                    key={i}
                                    className={`font-heading font-black text-5xl md:text-7xl lg:text-[6.5rem] tracking-tight leading-[1.1] h-full flex items-center shrink-0 ${w.color}`}
                                >
                                    {w.text}
                                </span>
                            ))}
                        </div>
                    </div>
                </div>

                <p className="hero-text mt-8 text-lg md:text-xl text-white/70 max-w-2xl font-light leading-relaxed">
                    Learn to drive with judgment. Understand why you're doing what you do. Become the driver you want to be.
                </p>

                <div className="hero-cta mt-12 flex flex-col sm:flex-row gap-4 items-start sm:items-center">
                    <button className="btn-magnetic bg-blue text-white px-8 py-4 rounded-full font-heading font-semibold text-lg hover:shadow-[0_0_25px_rgba(2,92,165,0.5)] border border-blue/50">
                        Book a Lesson
                    </button>
                    <button className="btn-magnetic bg-transparent text-white px-8 py-4 rounded-full font-heading font-semibold text-lg hover:bg-white/5 border border-white/20">
                        Learn How This Works
                    </button>
                </div>
            </div>
        </section>
    );
}
