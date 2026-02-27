'use client';
import { useState, useEffect, useRef } from 'react';

const steps = [
  {
    num: '01',
    title: 'Environmental Integration',
    desc: 'Stop practising; start performing. We use high-fidelity road environments to build the pattern recognition and safe decision-making required for real-world traffic flow.',
    vizType: 'rotate',
  },
  {
    num: '02',
    title: 'Technical Rationale',
    desc: 'We bridge the gap between "what" and "why." When you understand the physics and logic behind a manoeuvre, the rules fade away and true driver safety becomes second nature.',
    vizType: 'scan',
  },
  {
    num: '03',
    title: 'Precision Refinement',
    desc: 'Every session is engineered deliberate practice. We isolate specific performance gaps to ensure every hour behind the wheel builds elite intuition and safe habits.',
    vizType: 'pulse',
  },
];

export default function Protocol() {
  return (
    <section id="protocol" className="relative bg-primary py-32 px-6 md:px-16">
      <div className="max-w-7xl mx-auto mb-20 text-center">
        <h2 className="font-heading font-black italic text-4xl md:text-6xl text-white mb-6">
          Three Pillars of Mastery
        </h2>
        <p className="text-white/60 font-light text-xl">The NexDrive Methodology.</p>
      </div>

      <div className="relative max-w-7xl mx-auto flex flex-col gap-8">
        {steps.map((step, i) => (
          <ProtocolCard key={i} step={step} index={i} />
        ))}
      </div>
    </section>
  );
}

function ProtocolCard({ step, index }: { step: typeof steps[0]; index: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) setVisible(true); },
      { threshold: 0.2 }
    );
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={`bg-slate border border-white/5 p-12 md:p-16 rounded-[3rem] shadow-2xl flex flex-col md:flex-row items-center justify-between gap-12 relative overflow-hidden transition-all duration-700 ${
        visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-12'
      }`}
      style={{ transitionDelay: `${index * 100}ms` }}
    >
      <div className="absolute top-0 right-0 w-96 h-96 bg-accent opacity-5 blur-[120px] rounded-full pointer-events-none" />

      <div className="flex-1 z-10">
        <span className="text-data text-accent text-lg md:text-2xl mb-4 block">[{step.num}]</span>
        <h3 className="font-heading font-bold text-4xl md:text-6xl text-white mb-6 tracking-tight">
          {step.title}
        </h3>
        <p className="font-light text-xl text-white/60 leading-relaxed max-w-sm">{step.desc}</p>
      </div>

      <div className="relative w-full md:w-1/2 aspect-square max-w-sm flex items-center justify-center bg-primary/30 rounded-full border border-white/5 p-8 z-10">
        {step.vizType === 'rotate' && <RotateViz />}
        {step.vizType === 'scan' && <ScanViz />}
        {step.vizType === 'pulse' && <PulseViz />}
      </div>
    </div>
  );
}

function RotateViz() {
  const [deg, setDeg] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setDeg((d) => d + 1), 50);
    return () => clearInterval(id);
  }, []);
  return (
    <div
      className="w-full h-full border-4 border-dashed border-accent/40 rounded-full flex items-center justify-center"
      style={{ transform: `rotate(${deg}deg)` }}
    >
      <div className="w-2/3 h-2/3 border border-white/20 rounded-full" />
    </div>
  );
}

function ScanViz() {
  const [y, setY] = useState(0);
  const [dir, setDir] = useState(1);
  useEffect(() => {
    const id = setInterval(() => {
      setY((prev) => {
        const next = prev + dir * 2;
        if (next >= 90 || next <= 0) setDir((d) => -d);
        return next;
      });
    }, 30);
    return () => clearInterval(id);
  }, [dir]);
  return (
    <div className="w-full h-full relative border border-white/10 overflow-hidden bg-black/20">
      <div
        className="w-full h-1 bg-accent absolute shadow-[0_0_15px_rgba(140,198,63,0.8)]"
        style={{ top: `${y}%` }}
      />
      <div className="grid grid-cols-5 gap-2 opacity-20 p-4 h-full">
        {Array(25).fill(0).map((_, i) => <div key={i} className="bg-white rounded-sm" />)}
      </div>
    </div>
  );
}

function PulseViz() {
  const [offset, setOffset] = useState(200);
  useEffect(() => {
    let frame: number;
    let start = 0;
    const animate = (ts: number) => {
      if (!start) start = ts;
      const elapsed = (ts - start) / 2000;
      setOffset(Math.max(0, 200 - elapsed * 200));
      if (elapsed < 1) {
        frame = requestAnimationFrame(animate);
      } else {
        setTimeout(() => { start = 0; setOffset(200); frame = requestAnimationFrame(animate); }, 1000);
      }
    };
    frame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <svg className="w-full h-full" viewBox="0 0 100 100" fill="none" stroke="currentColor">
      <path
        className="text-accent"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray="200"
        strokeDashoffset={offset}
        d="M 10 50 L 30 50 L 40 20 L 60 80 L 70 50 L 90 50"
      />
    </svg>
  );
}
