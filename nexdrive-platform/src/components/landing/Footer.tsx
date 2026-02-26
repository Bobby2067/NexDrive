import { Shield } from 'lucide-react';
import Image from 'next/image';

export default function Footer() {
  return (
    <footer className="bg-[#050508] text-white/60 pt-24 pb-12 px-6 md:px-16 rounded-t-[4rem] relative mt-[-2rem] z-20">
      <div className="max-w-7xl mx-auto grid grid-cols-1 md:grid-cols-4 gap-12 mb-16">
        <div className="md:col-span-2">
          <div className="mb-6 max-w-[240px]">
            <Image src="/nexdrive-logo.png" alt="NexDrive Academy" width={240} height={72} className="w-full h-auto drop-shadow-md opacity-90" />
          </div>
          <p className="font-light max-w-sm mb-8 text-white/40">
            Precision training for a lifetime of unscripted environments.
            Real skills, real confidence, real drivers.
          </p>
          <div className="flex items-center gap-3 text-xs text-data">
            <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
            <span className="text-white/80 uppercase tracking-widest">System Operational</span>
          </div>
        </div>

        <div>
          <h4 className="font-heading font-semibold text-white mb-6">Parent Support</h4>
          <ul className="space-y-4 font-light text-sm text-white/60">
            <li>Curious what real parent coaching looks like?</li>
            <li>
              <a href="#" className="flex items-center gap-2 text-accent font-semibold hover:text-white transition-colors">
                Download Free Parent Guide
              </a>
            </li>
          </ul>
        </div>

        <div>
          <h4 className="font-heading font-semibold text-white mb-6">Engagement</h4>
          <ul className="space-y-4 font-light text-sm">
            <li><a href="#approach" className="hover:text-blue transition-colors">Why NexDrive?</a></li>
            <li><a href="#investment" className="hover:text-blue transition-colors">Book a Lesson</a></li>
            <li>
              <a href="/sign-in" className="hover:text-blue transition-colors flex items-center gap-2">
                <Shield size={14} /> Secure Portal
              </a>
            </li>
          </ul>
        </div>
      </div>

      <div className="max-w-7xl mx-auto border-t border-white/10 pt-8 flex flex-col md:flex-row justify-between items-center text-xs text-data text-white/30">
        <p>&copy; {new Date().getFullYear()} NexDrive Academy. All rights reserved. Canberra, ACT, Australia.</p>
        <div className="flex gap-6 mt-4 md:mt-0">
          <a href="#" className="hover:text-white transition-colors">Privacy Policy</a>
          <a href="#" className="hover:text-white transition-colors">Terms of Service</a>
        </div>
      </div>
    </footer>
  );
}
