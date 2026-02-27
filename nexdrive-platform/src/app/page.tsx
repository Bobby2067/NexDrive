import Navbar from '@/components/landing/Navbar';
import Hero from '@/components/landing/Hero';
import Features from '@/components/landing/Features';
import Philosophy from '@/components/landing/Philosophy';
import AboutRob from '@/components/landing/AboutRob';
import ParentCoaching from '@/components/landing/ParentCoaching';
import Protocol from '@/components/landing/Protocol';
import CTA from '@/components/landing/CTA';
import Footer from '@/components/landing/Footer';

export default function Home() {
  return (
    <main className="bg-primary min-h-screen text-white">
      <Navbar />
      <Hero />
      <Features />
      <Philosophy />
      <AboutRob />
      <ParentCoaching />
      <Protocol />
      <CTA />
      <Footer />
    </main>
  );
}
