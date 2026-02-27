export default function Philosophy() {
  return (
    <section className="relative w-full py-48 px-6 md:px-16 overflow-hidden bg-primary flex items-center justify-center">
      <div className="absolute inset-0 z-0 opacity-10 pointer-events-none">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="https://images.unsplash.com/photo-1542282088-72c9c27ed0cd?q=80&w=2000"
          alt=""
          className="w-full h-full object-cover absolute inset-0"
        />
        <div className="absolute inset-0 bg-gradient-to-b from-primary via-transparent to-primary" />
      </div>

      <div className="relative z-10 max-w-4xl w-full">
        <div className="mb-12">
          <span className="inline-block text-data text-xs tracking-[0.25em] text-accent uppercase mb-4">
            Intuition Over Imitation
          </span>
          <p className="font-heading text-xl md:text-3xl text-white/50 leading-relaxed font-light">
            Memorised rules get you through a test.{' '}
            <span className="text-white/80">
              Real judgment gets you through a lifetime of safe, adaptive driving.
            </span>
          </p>
        </div>

        <div className="mt-8 border-l-4 border-accent pl-8 md:pl-12">
          <p className="font-heading font-bold text-3xl md:text-4xl lg:text-5xl leading-tight text-white/90 tracking-tight">
            We don&apos;t just teach you to pass.{' '}
            <br className="hidden md:block" />
            We train you to{' '}
            <span className="text-accent underline decoration-accent/30 underline-offset-8">
              perceive, analyse, and lead the road.
            </span>
          </p>
        </div>
      </div>
    </section>
  );
}
