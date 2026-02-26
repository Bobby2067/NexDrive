'use client';
import { useState, useEffect, useRef } from 'react';

const words = [
  { text: 'Skills.',      color: 'text-white/90' },
  { text: 'Confidence.', color: 'text-blue drop-shadow-[0_10px_30px_rgba(2,92,165,0.4)]' },
  { text: 'Drivers.',    color: 'text-accent drop-shadow-[0_10px_30px_rgba(140,198,63,0.3)]' },
];

export default function Hero() {
  const [wordIndex, setWordIndex] = useState(0);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // Fade in on mount
    const t = setTimeout(() => setVisible(true), 100);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      setWordIndex((prev) => (prev + 1) % words.length);
    }, 2200);
    return () => clearInterval(interval);
  }, []);

  return (
    <section className="relative h-[100dvh] w-full flex items-end pb-24 px-6 md:px-16 overflow-hidden">
      {/* Background */}
      <div className="absolute inset-0 z-0">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="https://images.unsplash.com/photo-1469285994282-454ceb49e63c?q=80&w=2000"
          alt=""
          className="w-full h-full object-cover opacity-60"
          loading="eager"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-primary via-primary/80 to-transparent" />
      </div>

      {/* Content */}
      <div className={`relative z-10 max-w-4xl text-left transition-all duration-1000 ${visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-10'}`}>
        <div className="flex flex-wrap items-center gap-x-4">
          <span className="font-heading font-bold text-5xl md:text-7xl lg:text-[6.5rem] tracking-tight text-white/90 py-2">
            Real
          </span>
          <div className="relative h-[60px] md:h-[90px] lg:h-[130px] overflow-hidden w-[320px] sm:w-[350px] md:w-[480px] lg:w-[650px] shrink-0">
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

        <p
          className="mt-8 text-lg md:text-xl text-white/70 max-w-2xl font-light leading-relaxed"
          style={{ transitionDelay: '200ms' }}
        >
          Learn to drive with judgment. Understand why you&apos;re doing what you do.
          Become the driver you want to be.
        </p>

        <div className="mt-12 flex flex-col sm:flex-row gap-4 items-start sm:items-center" style={{ transitionDelay: '400ms' }}>
          <a href="#investment" className="btn-magnetic bg-blue text-white px-8 py-4 rounded-full font-heading font-semibold text-lg hover:shadow-[0_0_25px_rgba(2,92,165,0.5)] border border-blue/50">
            Book a Lesson
          </a>
          <a href="#protocol" className="btn-magnetic bg-transparent text-white px-8 py-4 rounded-full font-heading font-semibold text-lg hover:bg-white/5 border border-white/20">
            Learn How This Works
          </a>
        </div>
      </div>
    </section>
  );
}
