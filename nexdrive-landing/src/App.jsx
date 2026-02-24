import Navbar from './components/Navbar';
import Hero from './components/Hero';
import Features from './components/Features';
import Philosophy from './components/Philosophy';
import Protocol from './components/Protocol';
import CTA from './components/CTA';
import Footer from './components/Footer';

function App() {
  return (
    <main className="bg-primary min-h-screen text-background selection:bg-accent selection:text-primary">
      <Navbar />
      <Hero />
      <Features />
      <Philosophy />
      <Protocol />
      <CTA />
      <Footer />
    </main>
  );
}

export default App;
