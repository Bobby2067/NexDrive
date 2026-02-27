import { useLayoutEffect, useRef } from 'react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

export default function Philosophy() {
    const container = useRef(null);

    useLayoutEffect(() => {
        let ctx = gsap.context(() => {
            // Parallax Background
            gsap.to('.parallax-bg', {
                yPercent: 30,
                ease: 'none',
                scrollTrigger: {
                    trigger: container.current,
                    start: 'top bottom',
                    end: 'bottom top',
                    scrub: true,
                },
            });

            // Text Reveal
            gsap.from('.reveal-line', {
                y: 40,
                opacity: 0,
                duration: 1.5,
                stagger: 0.3,
                ease: 'power3.out',
                scrollTrigger: {
                    trigger: container.current,
                    start: 'top 60%',
                }
            });
        }, container);
        return () => ctx.revert();
    }, []);

    return (
        <section ref={container} className="relative w-full py-48 px-6 md:px-16 overflow-hidden bg-primary flex items-center justify-center">
            {/* Texture Background */}
            <div className="absolute inset-0 z-0 opacity-10 pointer-events-none">
                <img
                    src="https://images.unsplash.com/photo-1542282088-72c9c27ed0cd?q=80&w=2000"
                    alt="Dark texture"
                    className="parallax-bg w-full h-[150%] object-cover absolute -top-[25%]"
                />
                <div className="absolute inset-0 bg-gradient-to-b from-primary via-transparent to-primary"></div>
            </div>

            <div className="relative z-10 max-w-4xl w-full">
                <div className="mb-12">
                    <span className="reveal-line inline-block font-data text-sm tracking-[0.2em] text-white/40 uppercase mb-4">Real Judgment vs. Memorized Rules</span>
                    <p className="reveal-line font-heading text-xl md:text-3xl text-white/50 leading-relaxed font-light">
                        Memorized rules get you through a day. <span className="text-white/80">Real judgment gets you through a lifetime.</span>
                    </p>
                </div>

                <div className="mt-8 border-l-4 border-accent pl-8 md:pl-12">
                    <p className="reveal-line font-heading font-bold text-3xl md:text-4xl lg:text-5xl leading-tight text-white/90 tracking-tight mb-6">
                        We don't just teach you to pass a test. We train you to <br />
                        <span className="text-accent underline decoration-accent/30 underline-offset-8">recognize patterns and adapt.</span>
                    </p>
                </div>
            </div>
        </section>
    );
}
