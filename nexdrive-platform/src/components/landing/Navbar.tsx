'use client';
import { useState, useEffect } from 'react';
import Image from 'next/image';
import { Menu, X } from 'lucide-react';

export default function Navbar() {
  const [scrolled, setScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 100);
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const links = [
    { label: 'Roadcraft', href: '#approach' },
    { label: 'Methodology', href: '#protocol' },
    { label: 'Investment', href: '#investment' },
  ];

  return (
    <>
      <nav
        className={`fixed top-6 left-1/2 -translate-x-1/2 z-50 flex items-center justify-between px-6 py-4 rounded-[2rem] transition-all duration-500 w-[95%] max-w-5xl ${
          scrolled
            ? 'bg-primary/90 backdrop-blur-xl border border-blue/20 shadow-[-10px_10px_30px_rgba(2,92,165,0.1),_10px_10px_30px_rgba(140,198,63,0.05)]'
            : 'bg-transparent border border-transparent'
        }`}
      >
        <div className="flex flex-col items-start leading-none w-[280px] md:w-[380px]">
          <Image
            src="/nexdrive-logo.png"
            alt="NexDrive Academy"
            width={200}
            height={60}
            className="w-full h-auto drop-shadow-md"
            priority
          />
        </div>

        <div className="hidden md:flex items-center gap-8 text-sm font-medium text-white/70">
          {links.map((l) => (
            <a key={l.label} href={l.href} className="hover:text-white transition-colors">
              {l.label}
            </a>
          ))}
        </div>

        <div className="hidden md:block">
          <a
            href="#investment"
            className="btn-magnetic px-6 py-2.5 rounded-full bg-blue text-white font-semibold text-sm shadow-[0_0_15px_rgba(2,92,165,0.4)] hover:shadow-[0_0_25px_rgba(2,92,165,0.6)]"
          >
            Start Journey
          </a>
        </div>

        <button className="md:hidden text-white" onClick={() => setMobileOpen(!mobileOpen)} aria-label="Menu">
          {mobileOpen ? <X size={24} /> : <Menu size={24} />}
        </button>
      </nav>

      {/* Mobile Menu */}
      <div
        className={`fixed inset-0 z-40 bg-primary flex flex-col items-center justify-center gap-8 transition-opacity duration-300 ${
          mobileOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        }`}
      >
        {links.map((l) => (
          <a
            key={l.label}
            href={l.href}
            onClick={() => setMobileOpen(false)}
            className="text-2xl font-heading font-bold text-white"
          >
            {l.label}
          </a>
        ))}
        <a
          href="#investment"
          className="px-8 py-4 rounded-full bg-accent text-primary font-semibold mt-4 text-lg"
          onClick={() => setMobileOpen(false)}
        >
          Start Journey
        </a>
      </div>
    </>
  );
}
