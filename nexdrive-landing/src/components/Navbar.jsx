import { useState, useEffect } from 'react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { Menu, X } from 'lucide-react';

gsap.registerPlugin(ScrollTrigger);

export default function Navbar() {
    const [scrolled, setScrolled] = useState(false);
    const [mobileOpen, setMobileOpen] = useState(false);

    useEffect(() => {
        const handleScroll = () => {
            setScrolled(window.scrollY > 100);
        };
        window.addEventListener('scroll', handleScroll);
        return () => window.removeEventListener('scroll', handleScroll);
    }, []);

    return (
        <>
            <div
                className={`fixed top-6 left-1/2 -translate-x-1/2 z-50 flex items-center justify-between px-6 py-4 rounded-[2rem] transition-all duration-500 w-[95%] max-w-5xl ${scrolled
                    ? 'bg-primary/90 backdrop-blur-xl border border-blue/20 shadow-[-10px_10px_30px_rgba(2,92,165,0.1),_10px_10px_30px_rgba(140,198,63,0.05)]'
                    : 'bg-transparent border border-transparent'
                    }`}
            >
                <div className="flex flex-col items-start leading-none relative group cursor-pointer w-[140px] md:w-[220px]">
                    <img src="/nexdrive-logo.png" alt="NexDrive Academy Logo" className="w-full h-auto drop-shadow-md" />
                </div>

                <div className="hidden md:flex items-center gap-8 text-sm font-medium text-white/70 mt-2">
                    <a href="#approach" className="hover:text-white transition-colors">Approach</a>
                    <a href="#protocol" className="hover:text-white transition-colors">Protocol</a>
                    <a href="#investment" className="hover:text-white transition-colors">Investment</a>
                </div>

                <div className="hidden md:block mt-2">
                    <button className="btn-magnetic px-6 py-2.5 rounded-full bg-blue text-white font-semibold text-sm hover:scale-105 transition-transform duration-300 shadow-[0_0_15px_rgba(2,92,165,0.4)] hover:shadow-[0_0_25px_rgba(2,92,165,0.6)]">
                        Start Journey
                    </button>
                </div>

                <button
                    className="md:hidden text-white mt-2"
                    onClick={() => setMobileOpen(!mobileOpen)}
                >
                    {mobileOpen ? <X size={24} /> : <Menu size={24} />}
                </button>
            </div>

            {/* Mobile Menu */}
            <div className={`fixed inset-0 z-40 bg-primary flex flex-col items-center justify-center gap-8 transition-opacity duration-300 ${mobileOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}`}>
                <a href="#approach" onClick={() => setMobileOpen(false)} className="text-2xl font-heading text-white">Approach</a>
                <a href="#protocol" onClick={() => setMobileOpen(false)} className="text-2xl font-heading text-white">Protocol</a>
                <a href="#investment" onClick={() => setMobileOpen(false)} className="text-2xl font-heading text-white">Investment</a>
                <button className="px-8 py-4 rounded-full bg-accent text-primary font-semibold mt-4">
                    Start Journey
                </button>
            </div>
        </>
    );
}
