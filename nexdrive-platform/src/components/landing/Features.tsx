'use client';
import { useEffect, useState } from 'react';
import { MousePointer2, GitCommitHorizontal, Crosshair } from 'lucide-react';

export default function Features() {
  return (
    <section id="approach" className="relative z-20 py-32 px-6 md:px-16">
      <div className="max-w-7xl mx-auto">
        <div className="mb-20 text-center max-w-4xl mx-auto">
          <h2 className="font-heading font-black italic text-4xl md:text-6xl text-white mb-6">
            The Art of <span className="text-accent">Roadcraft</span>
          </h2>
          <p className="text-white/60 text-lg md:text-xl leading-relaxed">
            Move beyond basics. Learn to bridge the gap between basic operation and{' '}
            <span className="text-accent">expert-level situational awareness</span>.
          </p>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <PerceptionCard />
          <CognitionCard />
          <RefinementCard />
        </div>
      </div>
    </section>
  );
}

function PerceptionCard() {
  const [items, setItems] = useState([
    { id: 1, label: 'Pattern Recognition', sub: 'Identify emerging hazards before they form.' },
    { id: 2, label: 'Spatial Awareness', sub: 'Read the full road environment at speed.' },
    { id: 3, label: 'Risk Neutralisation', sub: 'Act before the threat becomes critical.' },
  ]);

  useEffect(() => {
    const interval = setInterval(() => {
      setItems((prev) => {
        const next = [...prev];
        const last = next.pop()!;
        next.unshift(last);
        return next;
      });
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="bg-primary border-t border-l border-white/10 border-b-2 border-r-2 border-b-blue/30 border-r-blue/30 rounded-[2rem] p-8 h-[28rem] flex flex-col relative overflow-hidden shadow-[10px_10px_30px_rgba(0,0,0,0.5)]">
      <div className="flex items-center gap-2 mb-8">
        <Crosshair size={20} className="text-accent" />
        <span className="text-data text-xs uppercase tracking-wider text-blue font-semibold">Advanced Perception</span>
      </div>
      <div className="relative flex-1">
        {items.map((item, index) => (
          <div
            key={item.id}
            className="absolute top-0 left-0 w-full bg-slate border border-white/10 rounded-2xl p-6 transition-all duration-[800ms] ease-[cubic-bezier(0.34,1.56,0.64,1)]"
            style={{
              transform: `translateY(${index * 20}px) scale(${1 - index * 0.05})`,
              opacity: 1 - index * 0.2,
              zIndex: 10 - index,
            }}
          >
            <h3 className="font-heading font-semibold text-white/90 text-lg">{item.label}</h3>
            <p className="text-data text-xs text-white/50 mt-2">{item.sub}</p>
          </div>
        ))}
      </div>
      <div className="mt-auto pt-6 border-t border-white/10">
        <h4 className="font-heading font-bold text-xl text-white mb-2">Predictive Roadcraft.</h4>
        <p className="text-sm text-white/60">
          Master the ability to &ldquo;see the invisible.&rdquo; Identify emerging patterns and neutralise
          risks for a higher standard of safe driving.
        </p>
      </div>
    </div>
  );
}

function CognitionCard() {
  const text = '> Analysing the physics...\n> Understanding the rationale...\n> Confidence acquired.\n> Rules fade away.';
  const [displayed, setDisplayed] = useState('');
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (index < text.length) {
      const timeout = setTimeout(() => {
        setDisplayed((prev) => prev + text.charAt(index));
        setIndex(index + 1);
      }, Math.random() * 50 + 20);
      return () => clearTimeout(timeout);
    } else {
      const timeout = setTimeout(() => { setDisplayed(''); setIndex(0); }, 5000);
      return () => clearTimeout(timeout);
    }
  }, [index, text]);

  return (
    <div className="bg-primary border-t border-l border-white/10 border-b-2 border-r-2 border-b-blue/30 border-r-blue/30 rounded-[2rem] p-8 h-[28rem] flex flex-col relative overflow-hidden shadow-[10px_10px_30px_rgba(0,0,0,0.5)]">
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-2 font-semibold">
          <GitCommitHorizontal size={20} className="text-accent" />
          <span className="text-data text-xs uppercase tracking-wider text-blue">Cognitive Certainty</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-accent animate-pulse" />
          <span className="text-data text-[10px] text-accent/80 uppercase">Processing</span>
        </div>
      </div>
      <div className="flex-1 bg-black/60 rounded-xl p-6 text-data text-sm text-accent whitespace-pre-wrap overflow-hidden border border-white/5">
        {displayed}<span className="inline-block w-2 bg-accent ml-1 animate-pulse">&nbsp;</span>
      </div>
      <div className="mt-auto pt-6 border-t border-white/10">
        <h4 className="font-heading font-bold text-xl text-white mb-2">Informed Decisiveness.</h4>
        <p className="text-sm text-white/60">
          Confidence is the byproduct of understanding. When you grasp the technical rationale
          behind every move, you gain the certainty needed for safe, proactive driving.
        </p>
      </div>
    </div>
  );
}

function RefinementCard() {
  const [highlighted, setHighlighted] = useState(3);
  const days = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

  useEffect(() => {
    const interval = setInterval(() => setHighlighted((prev) => (prev + 1) % 7), 1500);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="bg-primary border-t border-l border-white/10 border-b-2 border-r-2 border-b-blue/30 border-r-blue/30 rounded-[2rem] p-8 h-[28rem] flex flex-col relative overflow-hidden shadow-[10px_10px_30px_rgba(0,0,0,0.5)]">
      <div className="flex items-center gap-2 mb-8">
        <MousePointer2 size={20} className="text-accent" />
        <span className="text-data text-xs uppercase tracking-wider text-blue font-semibold">Strategic Refinement</span>
      </div>
      <div className="flex-1 flex flex-col items-center justify-center">
        <div className="grid grid-cols-7 gap-2 w-full max-w-[200px] mb-6">
          {days.map((d, i) => (
            <div
              key={i}
              className={`aspect-square rounded border border-white/10 flex items-center justify-center text-data text-xs transition-all duration-500 ${
                i === highlighted ? 'bg-accent text-primary border-accent font-bold' : 'text-white/40'
              }`}
            >
              {d}
            </div>
          ))}
        </div>
        <div className="px-6 py-2 rounded-full border border-white/20 text-xs font-heading font-semibold text-white/70">
          Isolate. Target. Improve.
        </div>
      </div>
      <div className="mt-auto pt-6 border-t border-white/10">
        <h4 className="font-heading font-bold text-xl text-white mb-2">Purposeful Progression.</h4>
        <p className="text-sm text-white/60">
          We don&apos;t just &ldquo;clock hours.&rdquo; Every session is engineered to target specific technical
          gaps, building the real-world skills essential for long-term driver safety.
        </p>
      </div>
    </div>
  );
}
