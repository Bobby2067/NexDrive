# SPEC-06: Website & Booking Widget (C01 + C02)
### NexDrive Academy — Phase 1 Revenue Engine
**Version:** 1.0  
**Date:** 21 February 2026  
**Status:** Ready for Implementation  
**Depends On:** System Architecture v1.1 §4.2.2; SPEC-01 (Database Schema); SPEC-02 (Auth & RBAC); SPEC-03 (Booking Engine API); SPEC-04 (Payment Engine API); SPEC-05 (CRM Contacts API)  
**Phase:** 1 (Revenue Engine — Weeks 3-6)  
**Estimated Effort:** 8-10 days  
**Build Tools:** v0 (initial design), Cursor (implementation)

---

## 1. Overview

C01 (Public Website & SEO Engine) is the marketing and conversion frontend for NexDrive Academy. C02 (Booking Widget) is the embedded booking flow that converts visitors into booked students. Together they form the customer-facing surface of the entire platform.

**This is a self-contained implementation brief.** A frontend developer (or AI coding agent) should be able to build the complete public website and booking widget from this spec alone.

### 1.1 Key Rules (Non-Negotiable)

1. **Server-rendered for SEO.** Every public page uses Next.js App Router with SSR or ISR. No client-only rendered content that Google can't index.
2. **Mobile-first design.** All components designed at 320px first, scaled up. Touch targets ≥ 44×44px.
3. **LCP < 2.5s, TTI < 3.5s.** Per NFR-1. Lighthouse score ≥ 90 on Performance, Accessibility, SEO.
4. **WCAG 2.1 AA.** Per NFR-4. Keyboard nav, ARIA labels, 4.5:1 contrast ratio minimum.
5. **Australian timezone.** All dates/times displayed in `Australia/Canberra`. The booking widget sends UTC to the API but displays AEST/AEDT to the user.
6. **No double-booking.** The widget enforces a 10-minute reservation hold via Redis lock (SPEC-03 §7). Expired slots release automatically.
7. **API-first.** The website reads all dynamic data from REST APIs. No direct database access from React components.
8. **All monetary values in integer cents.** Display as `$105.00` but pass `10500` to APIs.

### 1.2 Target Personas

| Persona | Journey | Priority |
|---------|---------|----------|
| **New learner (16-25)** | Google search → Homepage → Services → Book | #1 |
| **Parent/supervisor** | Google search → Homepage → About → Services → Book co-lesson | #2 |
| **Returning student** | Direct URL / SMS link → /book | #3 |
| **Referral visitor** | Friend's link → Homepage → Book | #4 |

### 1.3 Core Messaging

- **Tagline:** "Hours Build Familiarity. Together We Build Judgement."
- **Value proposition:** Rob doesn't just log hours — he teaches judgement, decision-making, and real-world driving skills using ACT's CBT&A framework.
- **Premium positioning:** NexDrive costs more because it delivers more. ADI-certified, CBT&A-compliant, structured progression, digital records.
- **Trust signals:** ADI Certified, ACT Government CBT&A Compliant, Digital Lesson Records, Real-Time Progress Tracking.

---

## 2. Tech Stack & Dependencies

```bash
# Core (already installed from Phase 0)
# next@14.x, react@18.x, typescript@5.x, tailwindcss@3.x

# New dependencies for SPEC-06
npm install @headlessui/react           # Accessible UI primitives (dialogs, menus, transitions)
npm install @heroicons/react            # Icon library (MIT licensed)
npm install date-fns                    # Date formatting (already in SPEC-03)
npm install date-fns-tz                 # Timezone display
npm install zustand                     # Lightweight state management for booking widget
npm install react-day-picker            # Accessible calendar component
npm install next-sitemap                # Auto-generate sitemap.xml + robots.txt
npm install next-seo                    # Meta tags + JSON-LD helpers
npm install sharp                       # Image optimisation for next/image
npm install clsx                        # Conditional classnames

npm install -D @types/react-day-picker
```

### 2.1 Environment Variables

Add to `.env.local`:

```env
# Public site
NEXT_PUBLIC_SITE_URL=https://nexdriveacademy.com.au
NEXT_PUBLIC_SITE_NAME=NexDrive Academy
NEXT_PUBLIC_DEFAULT_INSTRUCTOR_ID=xxx    # Rob's instructor UUID
NEXT_PUBLIC_BOOKING_TIMEZONE=Australia/Canberra
NEXT_PUBLIC_POSTHOG_KEY=phc_xxx
NEXT_PUBLIC_GA4_ID=G-XXXXXXXXXX

# Internal
RESEND_API_KEY=re_xxx                    # For contact form emails
```

---

## 3. Project Structure

```
src/
├── app/                                # Next.js App Router
│   ├── layout.tsx                      # Root layout (header, footer, analytics)
│   ├── page.tsx                        # Homepage (/)
│   ├── about/
│   │   └── page.tsx                    # /about
│   ├── services/
│   │   └── page.tsx                    # /services
│   ├── book/
│   │   └── page.tsx                    # /book (dedicated booking page)
│   ├── faq/
│   │   └── page.tsx                    # /faq
│   ├── contact/
│   │   └── page.tsx                    # /contact
│   ├── blog/                           # Phase 5 (placeholder layout for now)
│   │   ├── page.tsx                    # /blog (listing)
│   │   └── [slug]/
│   │       └── page.tsx                # /blog/:slug (article)
│   ├── api/                            # API routes (from SPEC-03, 04, 05)
│   │   └── v1/
│   │       └── contact-form/
│   │           └── route.ts            # POST /api/v1/contact-form
│   ├── sitemap.ts                      # Dynamic sitemap generation
│   └── robots.ts                       # Dynamic robots.txt
│
├── components/
│   ├── layout/                         # Structural components
│   │   ├── Header.tsx
│   │   ├── Footer.tsx
│   │   ├── MobileNav.tsx
│   │   └── PageContainer.tsx
│   │
│   ├── ui/                             # Design system primitives
│   │   ├── Button.tsx
│   │   ├── Card.tsx
│   │   ├── Input.tsx
│   │   ├── Select.tsx
│   │   ├── Badge.tsx
│   │   ├── Spinner.tsx
│   │   ├── Alert.tsx
│   │   ├── Dialog.tsx
│   │   └── ProgressBar.tsx
│   │
│   ├── marketing/                      # Page-specific sections
│   │   ├── Hero.tsx
│   │   ├── ValueProps.tsx
│   │   ├── ServicesPreview.tsx
│   │   ├── InstructorIntro.tsx
│   │   ├── TestimonialCard.tsx
│   │   ├── TestimonialCarousel.tsx
│   │   ├── CTABanner.tsx
│   │   ├── TrustBadges.tsx
│   │   ├── ServiceCard.tsx
│   │   └── FAQAccordion.tsx
│   │
│   └── booking/                        # C02 Booking Widget
│       ├── BookingWidget.tsx            # Main container + state orchestrator
│       ├── steps/
│       │   ├── ServiceSelect.tsx        # Step 1
│       │   ├── DateSelect.tsx           # Step 2
│       │   ├── TimeSelect.tsx           # Step 3
│       │   ├── ContactDetails.tsx       # Step 4
│       │   ├── VoucherEntry.tsx         # Step 5
│       │   ├── PaymentStep.tsx          # Step 6
│       │   └── Confirmation.tsx         # Step 7
│       ├── BookingProgress.tsx          # Step indicator bar
│       ├── ReservationTimer.tsx         # 10-min countdown display
│       ├── BookingSummary.tsx           # Sidebar/bottom summary
│       └── booking-store.ts            # Zustand store
│
├── lib/
│   ├── api-client.ts                   # Typed fetch wrapper for API calls
│   ├── format.ts                       # Currency, date, phone formatters
│   ├── analytics.ts                    # PostHog + GA4 event helpers
│   ├── seo.ts                          # JSON-LD schema generators
│   └── constants.ts                    # Site-wide constants
│
├── styles/
│   └── globals.css                     # Tailwind directives + custom CSS
│
└── public/
    ├── images/
    │   ├── logo.svg                    # NexDrive logo
    │   ├── logo-dark.svg               # Dark variant
    │   ├── rob-portrait.jpg            # Professional photo
    │   ├── hero-bg.jpg                 # Hero background
    │   ├── og-default.jpg              # Open Graph fallback image (1200×630)
    │   ├── adi-badge.svg               # ADI certified badge
    │   └── act-compliant.svg           # ACT CBT&A compliant badge
    ├── favicon.ico
    ├── apple-touch-icon.png
    └── manifest.json                   # PWA manifest
```

---

## 4. TailwindCSS Theme & Design System

### 4.1 Brand Configuration

```typescript
// tailwind.config.ts

import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        // Primary — Professional dark blue (trust, authority)
        primary: {
          50:  '#EFF6FF',
          100: '#DBEAFE',
          200: '#BFDBFE',
          300: '#93C5FD',
          400: '#60A5FA',
          500: '#2563EB',   // Main brand blue
          600: '#1D4ED8',   // Hover state
          700: '#1E40AF',   // Active state
          800: '#1E3A8A',
          900: '#172554',
        },
        // Accent — Energetic teal/green (growth, progress, confidence)
        accent: {
          50:  '#F0FDFA',
          100: '#CCFBF1',
          200: '#99F6E4',
          300: '#5EEAD4',
          400: '#2DD4BF',
          500: '#14B8A6',   // Main accent
          600: '#0D9488',
          700: '#0F766E',
          800: '#115E59',
          900: '#134E4A',
        },
        // Neutral — Warm grey (approachable, not sterile)
        neutral: {
          50:  '#FAFAF9',
          100: '#F5F5F4',
          200: '#E7E5E4',
          300: '#D6D3D1',
          400: '#A8A29E',
          500: '#78716C',
          600: '#57534E',
          700: '#44403C',
          800: '#292524',
          900: '#1C1917',
        },
        // Semantic
        success: '#16A34A',
        warning: '#EAB308',
        error:   '#DC2626',
        info:    '#2563EB',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        display: ['Plus Jakarta Sans', 'Inter', 'sans-serif'],
      },
      fontSize: {
        // Type scale — mobile-first, use responsive modifiers for desktop
        'display-lg': ['3rem',    { lineHeight: '1.1', letterSpacing: '-0.02em', fontWeight: '800' }],
        'display':    ['2.25rem', { lineHeight: '1.15', letterSpacing: '-0.02em', fontWeight: '700' }],
        'heading-1':  ['1.875rem', { lineHeight: '1.2', fontWeight: '700' }],
        'heading-2':  ['1.5rem',   { lineHeight: '1.25', fontWeight: '600' }],
        'heading-3':  ['1.25rem',  { lineHeight: '1.3', fontWeight: '600' }],
        'body-lg':    ['1.125rem', { lineHeight: '1.6' }],
        'body':       ['1rem',     { lineHeight: '1.6' }],
        'body-sm':    ['0.875rem', { lineHeight: '1.5' }],
        'caption':    ['0.75rem',  { lineHeight: '1.4' }],
      },
      spacing: {
        // Section spacing
        'section': '5rem',         // 80px — vertical space between page sections
        'section-sm': '3rem',      // 48px — compact section spacing
      },
      borderRadius: {
        'card': '0.75rem',         // 12px — card corners
        'button': '0.5rem',        // 8px — button corners
        'input': '0.5rem',         // 8px — input corners
        'badge': '9999px',         // Pill shape
      },
      boxShadow: {
        'card': '0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.06)',
        'card-hover': '0 10px 15px -3px rgba(0,0,0,0.08), 0 4px 6px -4px rgba(0,0,0,0.06)',
        'widget': '0 20px 25px -5px rgba(0,0,0,0.1), 0 8px 10px -6px rgba(0,0,0,0.1)',
      },
      maxWidth: {
        'content': '1200px',       // Main content width
        'narrow':  '720px',        // Article/form width
        'wide':    '1400px',       // Full-width sections
      },
      animation: {
        'fade-in': 'fadeIn 0.3s ease-out',
        'slide-up': 'slideUp 0.3s ease-out',
        'slide-right': 'slideRight 0.3s ease-out',
        'pulse-soft': 'pulseSoft 2s ease-in-out infinite',
      },
      keyframes: {
        fadeIn: { '0%': { opacity: '0' }, '100%': { opacity: '1' } },
        slideUp: { '0%': { opacity: '0', transform: 'translateY(10px)' }, '100%': { opacity: '1', transform: 'translateY(0)' } },
        slideRight: { '0%': { opacity: '0', transform: 'translateX(-10px)' }, '100%': { opacity: '1', transform: 'translateX(0)' } },
        pulseSoft: { '0%, 100%': { opacity: '1' }, '50%': { opacity: '0.7' } },
      },
    },
  },
  plugins: [
    require('@tailwindcss/typography'),     // Prose styling for blog content
    require('@tailwindcss/forms'),          // Form element resets
  ],
};

export default config;
```

### 4.2 Responsive Breakpoints

Mobile-first design. All styles default to smallest screen; use responsive modifiers to scale up.

| Breakpoint | Width | Target | Tailwind Prefix |
|------------|-------|--------|----------------|
| Base | 0-639px | Small mobile (320px min) | (none) |
| sm | 640px+ | Large mobile / small tablet | `sm:` |
| md | 768px+ | Tablet | `md:` |
| lg | 1024px+ | Desktop | `lg:` |
| xl | 1280px+ | Large desktop | `xl:` |

### 4.3 Global Fonts

Include in `src/app/layout.tsx` via `next/font`:

```typescript
import { Inter, Plus_Jakarta_Sans } from 'next/font/google';

const inter = Inter({ subsets: ['latin'], variable: '--font-sans' });
const jakarta = Plus_Jakarta_Sans({ subsets: ['latin'], variable: '--font-display' });
```

---

## 5. Component Library

### 5.1 Layout Components

#### `Header.tsx`

```
┌──────────────────────────────────────────────────────────────────┐
│  [Logo]   Home  About  Services  FAQ  Contact     [Book Now ►]  │
│                                                                   │
│  Mobile: [Logo]                               [☰ Hamburger]     │
└──────────────────────────────────────────────────────────────────┘
```

**Props:** None (reads route for active state)

**Behaviour:**
- Desktop (lg+): Horizontal nav with links, right-aligned CTA button.
- Mobile (< lg): Logo left, hamburger right. Hamburger opens `MobileNav`.
- Sticky on scroll with `bg-white/95 backdrop-blur-sm` and subtle border.
- CTA "Book Now" button uses `primary-500` fill, always visible.
- Active page indicated by `text-primary-600 font-semibold` + 2px bottom border.

**Implementation:**

```typescript
// src/components/layout/Header.tsx

'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Bars3Icon } from '@heroicons/react/24/outline';
import { Button } from '@/components/ui/Button';
import { MobileNav } from './MobileNav';

const NAV_LINKS = [
  { href: '/',          label: 'Home' },
  { href: '/about',     label: 'About' },
  { href: '/services',  label: 'Services' },
  { href: '/faq',       label: 'FAQ' },
  { href: '/contact',   label: 'Contact' },
] as const;

export function Header() {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 10);
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  return (
    <>
      <header
        className={clsx(
          'fixed top-0 left-0 right-0 z-50 transition-all duration-200',
          scrolled
            ? 'bg-white/95 backdrop-blur-sm border-b border-neutral-200 shadow-sm'
            : 'bg-white'
        )}
      >
        <div className="mx-auto max-w-content px-4 sm:px-6 lg:px-8">
          <div className="flex h-16 items-center justify-between lg:h-20">
            {/* Logo */}
            <Link href="/" className="flex items-center gap-2">
              <img src="/images/logo.svg" alt="NexDrive Academy" className="h-8 lg:h-10" />
            </Link>

            {/* Desktop nav */}
            <nav className="hidden lg:flex items-center gap-8" aria-label="Main navigation">
              {NAV_LINKS.map(({ href, label }) => (
                <Link
                  key={href}
                  href={href}
                  className={clsx(
                    'text-body-sm font-medium transition-colors hover:text-primary-600',
                    pathname === href
                      ? 'text-primary-600 border-b-2 border-primary-500 pb-1'
                      : 'text-neutral-700'
                  )}
                >
                  {label}
                </Link>
              ))}
            </nav>

            {/* Desktop CTA */}
            <div className="hidden lg:block">
              <Button href="/book" variant="primary" size="md">
                Book Now
              </Button>
            </div>

            {/* Mobile hamburger */}
            <button
              className="lg:hidden p-2 -mr-2 text-neutral-700"
              onClick={() => setMobileOpen(true)}
              aria-label="Open menu"
            >
              <Bars3Icon className="h-6 w-6" />
            </button>
          </div>
        </div>
      </header>

      {/* Spacer to prevent content jumping under fixed header */}
      <div className="h-16 lg:h-20" />

      <MobileNav open={mobileOpen} onClose={() => setMobileOpen(false)} />
    </>
  );
}
```

#### `MobileNav.tsx`

- Slide-out drawer from right.
- Uses `@headlessui/react` `Dialog` for accessibility (focus trap, Escape to close).
- Shows all nav links + "Book Now" CTA at bottom.
- Animates: backdrop fade + panel slide-right.

#### `Footer.tsx`

```
┌──────────────────────────────────────────────────────────────────┐
│  [Logo]           Quick Links          Contact                   │
│  NexDrive         Home                 📞 0XXX XXX XXX          │
│  Academy          About                📧 rob@nexdrive...       │
│                   Services             📍 Canberra, ACT          │
│  [ADI] [CBT&A]    FAQ                                            │
│                   Book Now                                       │
│                   Blog                                           │
│                                                                   │
│  ────────────────────────────────────────────────────────────── │
│  © 2026 NexDrive Academy. All rights reserved.    Privacy  Terms │
└──────────────────────────────────────────────────────────────────┘
```

**Props:** None  
**Layout:** 3-column on desktop (lg), stacked on mobile.  
**Contains:** Logo, nav links, contact info, trust badges, copyright, privacy/terms links.

### 5.2 UI Primitives

#### `Button.tsx`

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `variant` | `'primary' \| 'secondary' \| 'ghost' \| 'danger'` | `'primary'` | Visual style |
| `size` | `'sm' \| 'md' \| 'lg'` | `'md'` | Size variant |
| `href` | `string?` | — | If set, renders as `<Link>` |
| `disabled` | `boolean` | `false` | Disabled state |
| `loading` | `boolean` | `false` | Shows spinner, disables interaction |
| `fullWidth` | `boolean` | `false` | `w-full` |
| `icon` | `ReactNode?` | — | Leading icon |

**Style Map:**

```
primary:   bg-primary-500 text-white hover:bg-primary-600 active:bg-primary-700
secondary: bg-white text-primary-600 border border-primary-300 hover:bg-primary-50
ghost:     text-neutral-700 hover:bg-neutral-100
danger:    bg-error text-white hover:bg-red-700

sm:  px-3 py-1.5 text-body-sm   h-8
md:  px-5 py-2.5 text-body      h-10
lg:  px-7 py-3   text-body-lg   h-12

disabled: opacity-50 cursor-not-allowed
loading:  opacity-70 cursor-wait [spinner replaces icon]
```

**Focus style (all variants):** `focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 outline-none` — ensures keyboard accessibility.

#### `Card.tsx`

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `padding` | `'sm' \| 'md' \| 'lg'` | `'md'` | Internal padding |
| `hoverable` | `boolean` | `false` | Lift on hover |
| `selected` | `boolean` | `false` | Selected ring |

```
Base:      bg-white rounded-card shadow-card border border-neutral-100
Hoverable: hover:shadow-card-hover hover:-translate-y-0.5 transition-all
Selected:  ring-2 ring-primary-500 border-primary-300
```

#### `Input.tsx`

Standard form input with label, error state, and helper text.

| Prop | Type | Description |
|------|------|-------------|
| `label` | `string` | Label text |
| `error` | `string?` | Error message (shows red border + message) |
| `helper` | `string?` | Helper text below input |
| `required` | `boolean` | Shows asterisk on label |

**Error state:** `border-error focus:ring-error` + red error text with `role="alert"`.  
**ARIA:** `aria-describedby` links to helper/error, `aria-invalid` on error.

### 5.3 Marketing Components

#### `Hero.tsx`

```
┌──────────────────────────────────────────────────────────────────┐
│                                                                   │
│    NexDrive Academy                                              │
│                                                                   │
│    Hours Build Familiarity.                                      │
│    Together We Build Judgement.                                   │
│                                                                   │
│    Canberra's premium driving school. ADI-certified              │
│    instruction with structured competency-based training.         │
│                                                                   │
│    [Book Your First Lesson ►]   [View Services]                  │
│                                                                   │
│    ✓ ADI Certified   ✓ ACT CBT&A Compliant   ✓ Digital Records  │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

**Props:** None (content is hardcoded for homepage).  
**Desktop:** Split layout — text left, hero image/illustration right.  
**Mobile:** Stacked — text top, image below (or hidden to reduce LCP).  
**Background:** Subtle gradient from `primary-50` to white, or background image with overlay.

#### `ValueProps.tsx`

Three-column grid of value propositions (icon + heading + description).

| Prop | Content |
|------|---------|
| Column 1 | **Structured Learning** — "Not just hours on the road. Every lesson builds specific competencies tracked through ACT's CBT&A framework." |
| Column 2 | **Real-Time Progress** — "Digital lesson records. Track your progress across all 23 competency tasks. Know exactly where you stand." |
| Column 3 | **Premium Instruction** — "ADI-certified instructor. Patient, thorough, focused on building your judgement — not just passing a test." |

**Layout:** `grid grid-cols-1 md:grid-cols-3 gap-8`

#### `ServiceCard.tsx`

| Prop | Type | Description |
|------|------|-------------|
| `service` | `ServiceType` | Service data from API |
| `onBook` | `() => void` | Navigates to booking widget with service pre-selected |

```
┌──────────────────────────┐
│  [Category badge]        │
│                          │
│  Service Name            │
│  60 min                  │
│                          │
│  Brief description of    │
│  what this lesson covers │
│  and who it's for.       │
│                          │
│  $105.00                 │
│                          │
│  [Book Now ►]            │
└──────────────────────────┘
```

**Display:** `formatCurrency(service.price_cents)` — formats `10500` as `$105.00`.

#### `TrustBadges.tsx`

Horizontal row of trust signals. Each badge is an icon + short text.

- ADI Certified Instructor
- ACT CBT&A Compliant
- Digital Lesson Records
- Real-Time Progress Tracking

**Style:** `flex flex-wrap gap-4 justify-center` with each badge as `flex items-center gap-2 text-body-sm text-neutral-600`.

#### `CTABanner.tsx`

Full-width conversion banner. Used between page sections and at page bottom.

| Prop | Type | Description |
|------|------|-------------|
| `heading` | `string` | Banner heading |
| `subheading` | `string?` | Supporting text |
| `ctaText` | `string` | Button label |
| `ctaHref` | `string` | Button link (default `/book`) |
| `variant` | `'primary' \| 'accent'` | Colour scheme |

```
┌──────────────────────────────────────────────────────────────────┐
│  ██████████████████████████████████████████████████████████████  │
│  █                                                            █  │
│  █  Ready to Start Your Driving Journey?                     █  │
│  █  Book your first lesson today. It takes 2 minutes.        █  │
│  █                                                            █  │
│  █                    [Book Now ►]                            █  │
│  █                                                            █  │
│  ██████████████████████████████████████████████████████████████  │
└──────────────────────────────────────────────────────────────────┘
```

**Style:** `bg-primary-600 text-white` (primary variant) or `bg-accent-600 text-white` (accent variant). Rounded corners, centered content.

#### `FAQAccordion.tsx`

Accessible accordion using `@headlessui/react` `Disclosure`. Each item has a question (button) and answer (panel). Keyboard navigable. Animated open/close.

| Prop | Type | Description |
|------|------|-------------|
| `items` | `{ question: string; answer: string }[]` | FAQ data |

---

## 6. Page Specifications

### 6.1 Homepage (`/`)

**Route:** `src/app/page.tsx`  
**Rendering:** SSR (dynamic data for services) with ISR revalidation (60 seconds).

**Sections (top to bottom):**

| # | Section | Component | Data Source |
|---|---------|-----------|-------------|
| 1 | Hero | `<Hero />` | Static content |
| 2 | Trust badges | `<TrustBadges />` | Static content |
| 3 | Value propositions | `<ValueProps />` | Static content |
| 4 | Services preview | `<ServicesPreview />` | `GET /api/v1/booking/services` (top 3-4 services) |
| 5 | About Rob | `<InstructorIntro />` | Static content + image |
| 6 | Testimonials | `<TestimonialCarousel />` | Hardcoded array (Phase 1), database later |
| 7 | CTA banner | `<CTABanner />` | Static content |

**Data Fetching:**

```typescript
// src/app/page.tsx

import { getBookableServices } from '@/lib/api-client';

export default async function HomePage() {
  const services = await getBookableServices();
  // Render sections...
}

// Server-side fetch — no client-side API call
async function getBookableServices() {
  const res = await fetch(
    `${process.env.NEXT_PUBLIC_SITE_URL}/api/v1/booking/services`,
    { next: { revalidate: 60 } }
  );
  const data = await res.json();
  return data.data.services;
}
```

**SEO:**

```typescript
export const metadata: Metadata = {
  title: 'NexDrive Academy | Driving Lessons Canberra | ADI Certified',
  description: 'Premium driving lessons in Canberra. ADI-certified instructor. ACT CBT&A compliant. Structured competency-based training with real-time progress tracking. Book online.',
  keywords: ['driving lessons Canberra', 'driving school Canberra', 'learn to drive Canberra', 'ADI driving instructor ACT', 'CBT&A driving lessons'],
  openGraph: {
    title: 'NexDrive Academy — Driving Lessons Canberra',
    description: 'Hours Build Familiarity. Together We Build Judgement.',
    url: 'https://nexdriveacademy.com.au',
    siteName: 'NexDrive Academy',
    images: [{ url: '/images/og-default.jpg', width: 1200, height: 630, alt: 'NexDrive Academy' }],
    locale: 'en_AU',
    type: 'website',
  },
};
```

**JSON-LD (LocalBusiness):**

```typescript
// Embedded in page via <script type="application/ld+json">
const localBusinessSchema = {
  '@context': 'https://schema.org',
  '@type': 'DrivingSchool',
  name: 'NexDrive Academy',
  description: 'Premium driving lessons in Canberra with ADI-certified instruction.',
  url: 'https://nexdriveacademy.com.au',
  telephone: '+61XXXXXXXXX',
  email: 'rob@nexdriveacademy.com.au',
  address: {
    '@type': 'PostalAddress',
    addressLocality: 'Canberra',
    addressRegion: 'ACT',
    addressCountry: 'AU',
  },
  geo: {
    '@type': 'GeoCoordinates',
    latitude: -35.2809,
    longitude: 149.1300,
  },
  areaServed: {
    '@type': 'City',
    name: 'Canberra',
  },
  priceRange: '$$',
  openingHoursSpecification: [
    { '@type': 'OpeningHoursSpecification', dayOfWeek: ['Monday','Tuesday','Wednesday','Thursday','Friday'], opens: '07:00', closes: '18:00' },
    { '@type': 'OpeningHoursSpecification', dayOfWeek: 'Saturday', opens: '08:00', closes: '14:00' },
  ],
  hasCredential: [
    { '@type': 'EducationalOccupationalCredential', credentialCategory: 'ADI Certification' },
  ],
};
```

### 6.2 About Page (`/about`)

**Route:** `src/app/about/page.tsx`  
**Rendering:** Static (ISR, revalidate: 3600)

**Sections:**
1. **Page header** — "About NexDrive Academy" + subheading
2. **Rob's story** — Photo + narrative. Teaching philosophy. Why he started NexDrive. ADI certification. What sets him apart.
3. **Teaching approach** — How CBT&A works (plain English). "Every lesson has a purpose." Competency progression explained simply.
4. **Credentials** — ADI certified. Years of experience. Number of students taught. Pass rate (if available).
5. **CTA banner** — "Ready to experience the NexDrive difference?"

**SEO Title:** "About Rob Harrison | NexDrive Academy | ADI Certified Driving Instructor Canberra"  
**JSON-LD:** `Person` schema for Rob (linked from `DrivingSchool.employee`).

### 6.3 Services Page (`/services`)

**Route:** `src/app/services/page.tsx`  
**Rendering:** SSR with ISR (revalidate: 60). Services are dynamic from database.

**Data:** `GET /api/v1/booking/services` — returns all bookable services.

**Layout:**

```
┌──────────────────────────────────────────────────────────────────┐
│  Our Services                                                     │
│  Lessons tailored to where you are in your driving journey.      │
│                                                                   │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐                │
│  │  Learner   │  │  Extended  │  │  Intensive │                │
│  │  Lesson    │  │  Lesson    │  │  Session   │                │
│  │  60 min    │  │  90 min    │  │  120 min   │                │
│  │  $105      │  │  $155      │  │  $200      │                │
│  │ [Book Now] │  │ [Book Now] │  │ [Book Now] │                │
│  └────────────┘  └────────────┘  └────────────┘                │
│                                                                   │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐                │
│  │ Co-Lesson  │  │  Pre-Test  │  │  Review    │                │
│  │ (w/parent) │  │   Prep     │  │ Assessment │                │
│  │  60 min    │  │  60 min    │  │  60 min    │                │
│  │  $XXX      │  │  $XXX      │  │  $XXX      │                │
│  │ [Book Now] │  │ [Book Now] │  │ [Book Now] │                │
│  └────────────┘  └────────────┘  └────────────┘                │
│                                                                   │
│  ── What's Included in Every Lesson ──                           │
│  ✓ Digital lesson record  ✓ Competency tracking                 │
│  ✓ Post-lesson summary    ✓ Progress dashboard access            │
│                                                                   │
│  ══════════════════════════════════════════════════════════════  │
│  ║  Not sure which lesson is right for you? Book a free call.  ║  │
│  ║                      [Contact Rob ►]                         ║  │
│  ══════════════════════════════════════════════════════════════  │
└──────────────────────────────────────────────────────────────────┘
```

**"Book Now" behaviour:** Navigates to `/book?service={service_id}` — pre-selects the service in the booking widget.

**SEO Title:** "Driving Lesson Prices Canberra | NexDrive Academy Services"  
**JSON-LD:** `Service` schema for each service (name, description, price, duration).

```typescript
const serviceSchema = services.map(s => ({
  '@context': 'https://schema.org',
  '@type': 'Service',
  serviceType: 'DrivingLesson',
  name: s.name,
  description: s.description,
  provider: { '@type': 'DrivingSchool', name: 'NexDrive Academy' },
  areaServed: { '@type': 'City', name: 'Canberra' },
  offers: {
    '@type': 'Offer',
    price: (s.price_cents / 100).toFixed(2),
    priceCurrency: 'AUD',
  },
}));
```

### 6.4 FAQ Page (`/faq`)

**Route:** `src/app/faq/page.tsx`  
**Rendering:** Static (ISR, revalidate: 3600)

**Content:** Accordion of frequently asked questions. Minimum 10-15 questions covering:

| Category | Example Questions |
|----------|------------------|
| **Getting Started** | How do I book my first lesson? What do I need to bring? How old do I need to be? |
| **Lessons** | How long is a lesson? What areas of Canberra do you cover? Can a parent sit in? |
| **CBT&A** | What is CBT&A? How many competency tasks are there? How long does it take? |
| **Pricing** | How much do lessons cost? Do you offer packages? Can I pay with Afterpay? |
| **Cancellation** | What's your cancellation policy? Can I reschedule? |
| **Test Preparation** | How do I know when I'm ready for my test? What does pre-test prep include? |

**SEO Title:** "FAQ | NexDrive Academy | Driving Lessons Canberra"  
**JSON-LD:** `FAQPage` schema (critical for Google rich snippets).

```typescript
const faqSchema = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: faqItems.map(item => ({
    '@type': 'Question',
    name: item.question,
    acceptedAnswer: {
      '@type': 'Answer',
      text: item.answer,
    },
  })),
};
```

### 6.5 Contact Page (`/contact`)

**Route:** `src/app/contact/page.tsx`  
**Rendering:** Static shell, contact form is client component.

**Sections:**
1. **Contact details** — Phone, email, operating hours, service area (Canberra, ACT).
2. **Contact form** — Name, email, phone, message, submit. Posts to `POST /api/v1/contact-form` which: validates with Zod, sends email via Resend, creates CRM contact via SPEC-05 `upsertFromChannel()`.
3. **Embedded map** — Google Maps embed or static map image showing Canberra coverage area.
4. **Quick CTA** — "Prefer to book directly?" → Link to `/book`.

**Contact Form API:**

```typescript
// POST /api/v1/contact-form
// Body: { name: string, email: string, phone?: string, message: string }
// Actions:
//   1. Validate input (Zod)
//   2. Rate limit (10 per hour per IP via Upstash Redis)
//   3. Send email to Rob via Resend
//   4. Create/touch CRM contact via upsertFromChannel({ source: 'contact_form' })
//   5. Return { success: true }
```

**SEO Title:** "Contact NexDrive Academy | Book Driving Lessons Canberra"

### 6.6 Book Page (`/book`)

**Route:** `src/app/book/page.tsx`  
**Rendering:** Static shell with client-side `<BookingWidget />`.

**Layout:** Full-width page with the booking widget as the primary content. Minimal surrounding content — the page exists for direct linking from CTAs, SMS, voice agent, etc.

```
┌──────────────────────────────────────────────────────────────────┐
│  [Header - standard]                                              │
│                                                                   │
│  Book Your Lesson                                                │
│  Select a service, pick a time, and you're booked.               │
│                                                                   │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                                                            │  │
│  │                  [BOOKING WIDGET - C02]                    │  │
│  │                                                            │  │
│  │             (See Section 7 for full spec)                  │  │
│  │                                                            │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                   │
│  Need help? Call Rob on 0XXX XXX XXX or send us a message.      │
│                                                                   │
│  [Footer - standard]                                              │
└──────────────────────────────────────────────────────────────────┘
```

**URL Params:** `?service={service_id}` — if present, pre-selects the service and skips Step 1.

**SEO Title:** "Book a Driving Lesson | NexDrive Academy Canberra"

### 6.7 Blog (`/blog`) — Phase 5 Placeholder

**Route:** `src/app/blog/page.tsx` (listing) + `src/app/blog/[slug]/page.tsx` (article)  
**Phase 1 delivery:** Placeholder page with "Coming soon" message and email signup for updates.  
**Phase 5 delivery:** MDX-powered blog with categories, SEO-optimised articles targeting Canberra driving keywords.

---

## 7. Booking Widget (C02) — Complete Specification

### 7.1 Architecture

The booking widget is a self-contained React component that manages its own state via Zustand and communicates with the Booking Engine (SPEC-03) and Payment Engine (SPEC-04) APIs.

```
┌─────────────────────────────────────────────────────────────────┐
│  BookingWidget.tsx  (container + step router)                   │
│                                                                  │
│  ┌───────────────────────────────────────────────────────┐     │
│  │  BookingProgress.tsx (step indicator: 1 2 3 4 5 6 7)  │     │
│  └───────────────────────────────────────────────────────┘     │
│                                                                  │
│  ┌───────────────────────┐  ┌────────────────────────────┐    │
│  │                       │  │                            │    │
│  │  Active Step Panel    │  │  BookingSummary.tsx        │    │
│  │  (one of 7 steps)     │  │  - Selected service       │    │
│  │                       │  │  - Selected date/time     │    │
│  │                       │  │  - Price                  │    │
│  │                       │  │  - ReservationTimer.tsx   │    │
│  │                       │  │                            │    │
│  └───────────────────────┘  └────────────────────────────┘    │
│                                                                  │
│  Mobile: Summary collapses to sticky bottom bar                 │
└─────────────────────────────────────────────────────────────────┘
```

**Desktop layout:** 2-column — step panel (left, 60%) + summary sidebar (right, 40%).  
**Mobile layout:** Single column — step panel full width + sticky bottom bar showing price + timer.

### 7.2 Zustand Store

```typescript
// src/components/booking/booking-store.ts

import { create } from 'zustand';

interface BookingState {
  // Navigation
  currentStep: number;               // 1-7
  maxReachedStep: number;            // Prevents skipping ahead

  // Step 1: Service
  selectedService: ServiceType | null;

  // Step 2-3: Date/Time
  selectedDate: string | null;       // YYYY-MM-DD
  availableSlots: TimeSlot[];        // Loaded from API
  slotsLoading: boolean;
  selectedSlot: TimeSlot | null;

  // Step 4: Contact
  contactDetails: {
    first_name: string;
    last_name: string;
    phone: string;
    email: string;
    licence_number: string;
  };

  // Step 5: Voucher
  voucherCode: string;
  voucherDiscount: VoucherDiscount | null;
  voucherLoading: boolean;
  voucherError: string | null;

  // Reservation
  reservationId: string | null;
  reservationExpiresAt: string | null; // ISO 8601
  reservationExpired: boolean;

  // Step 6: Payment
  paymentIntentId: string | null;
  paymentStatus: 'idle' | 'processing' | 'succeeded' | 'failed';
  paymentError: string | null;

  // Step 7: Confirmation
  confirmedBooking: ConfirmedBooking | null;

  // Global
  error: string | null;

  // Actions
  setService: (service: ServiceType) => void;
  setDate: (date: string) => void;
  setSlot: (slot: TimeSlot) => void;
  setContactField: (field: string, value: string) => void;
  goToStep: (step: number) => void;
  goNext: () => void;
  goBack: () => void;
  reset: () => void;

  // Async actions (called from step components)
  loadAvailability: (date: string) => Promise<void>;
  createReservation: () => Promise<void>;
  validateVoucher: (code: string) => Promise<void>;
  confirmBooking: (paymentIntentId?: string) => Promise<void>;
}

// Types
interface ServiceType {
  id: string;
  name: string;
  slug: string;
  description: string;
  duration_minutes: number;
  price_cents: number;
  category: string;
}

interface TimeSlot {
  start: string;    // HH:mm (Australia/Canberra)
  end: string;      // HH:mm
  available: boolean;
}

interface VoucherDiscount {
  code: string;
  type: 'percentage' | 'fixed';
  amount: number;         // Percentage (e.g. 10) or cents (e.g. 1000)
  final_price_cents: number;
}

interface ConfirmedBooking {
  booking_id: string;
  service_name: string;
  date: string;
  start_time: string;
  end_time: string;
  instructor_name: string;
  price_paid_cents: number;
}
```

### 7.3 Step 1 — Service Selection (`ServiceSelect.tsx`)

**Data:** Fetched on mount via `GET /api/v1/booking/services`.

**Display:** Grid of `ServiceCard` components. Each card shows name, duration, price, brief description, category badge.

**Layout:** `grid grid-cols-1 sm:grid-cols-2 gap-4`

**Interaction:**
- Click card → sets `selectedService`, highlights card with `ring-2 ring-primary-500`.
- "Continue" button enabled only when a service is selected.
- If URL has `?service={id}`, auto-select and skip to Step 2.

**Category grouping:** Services grouped by category (`lesson`, `co_lesson`, `assessment`, `special`) with section headings.

### 7.4 Step 2 — Date Selection (`DateSelect.tsx`)

**Display:** Calendar component using `react-day-picker`. Month view. Shows current month + next month.

**Disabled dates:**
- Past dates.
- Dates before `min_notice_hours` (from service config). Example: if `min_notice_hours = 24` and it's 3 PM Monday, Tuesday is the earliest bookable date.
- Dates more than 28 days in the future (configurable).

**Interaction:**
- Click a date → sets `selectedDate`, calls `loadAvailability()`.
- Loading state while fetching slots.

**API Call:**

```typescript
// Fetch availability for selected date ± a few days (batch for adjacent dates)
const res = await fetch(
  `/api/v1/booking/availability?` +
  `instructor_id=${INSTRUCTOR_ID}` +
  `&service_id=${selectedService.id}` +
  `&date_from=${selectedDate}` +
  `&date_to=${selectedDate}`
);
```

**After fetch:** Automatically advance to Step 3 if slots are available. If no slots, show "No available times on this date. Try another day." with the calendar still visible.

### 7.5 Step 3 — Time Selection (`TimeSelect.tsx`)

**Display:** Grid of time slot buttons.

```
┌──────────────────────────────────────────┐
│  Available Times for Monday, 2 Mar 2026  │
│                                           │
│  [7:00 AM]  [7:30 AM]  [8:00 AM]        │
│  [8:30 AM]  [9:00 AM]  [9:30 AM]        │
│  [10:00 AM] [10:30 AM] [11:00 AM]       │
│  [1:00 PM]  [1:30 PM]  [2:00 PM]        │
│  [2:30 PM]  [3:00 PM]  [3:30 PM]        │
│                                           │
│  ⓘ Lessons start on the half-hour.       │
│     Selected: 9:00 AM - 10:00 AM        │
│                                           │
│  [← Back]              [Continue →]      │
└──────────────────────────────────────────┘
```

**Layout:** `grid grid-cols-3 sm:grid-cols-4 gap-2`

**Interaction:**
- Click slot → highlights with primary colour, shows end time in summary.
- "Continue" button advances to Step 4.

**Time display:** Format as `h:mm A` in `Australia/Canberra` timezone using `date-fns-tz`.

### 7.6 Step 4 — Contact Details (`ContactDetails.tsx`)

**Fields:**

| Field | Type | Validation | Required |
|-------|------|-----------|----------|
| First name | text | min 2 chars | ✅ |
| Last name | text | min 2 chars | ✅ |
| Phone | tel | AU mobile format (`04XX XXX XXX`) | ✅ |
| Email | email | Valid email | ✅ |
| Licence number | text | Optional for first booking | ❌ |

**Phone formatting:** As user types, auto-format to `04XX XXX XXX`. Store as E.164 (`+614XXXXXXXX`) for API.

**Validation:** Real-time (on blur) + full validation on "Continue". Use Zod schema matching SPEC-03 `CreateReservationSchema.contact`.

**Privacy note:** Small text below form: "Your information is stored securely in Australia. We'll only contact you about your booking."

**On Continue:** Calls `createReservation()` which:
1. Posts to `POST /api/v1/booking/reserve`
2. Receives `reservation_id` and `expires_at`
3. Starts the 10-minute countdown timer
4. Advances to Step 5

### 7.7 Step 5 — Voucher Entry (`VoucherEntry.tsx`)

**Display:** Optional step — user can skip. Single input + "Apply" button.

```
┌──────────────────────────────────────────┐
│  Have a voucher or promo code?           │
│                                           │
│  [Enter code...        ] [Apply]         │
│                                           │
│  ✅ SUMMER10 applied — 10% off!          │
│  Original: $105.00  →  Now: $94.50       │
│                                           │
│  [Skip]                 [Continue →]     │
└──────────────────────────────────────────┘
```

**API Call:** `POST /api/v1/vouchers/validate` with `{ code, service_id, booking_date }`.

**States:**
- Idle: Empty input + "Apply" button.
- Loading: Spinner on "Apply" button.
- Success: Green checkmark, discount amount shown, updated price.
- Error: Red text — "Invalid code", "Code expired", "Not applicable to this service".

**Store update:** On success, sets `voucherDiscount` with the discount details and new `final_price_cents`.

### 7.8 Step 6 — Payment (`PaymentStep.tsx`)

**Payment flow follows SPEC-04 (Payment Engine API).**

The payment step renders a gateway-specific payment form via the adapter pattern defined in SPEC-04. The widget does NOT handle card data directly — it embeds the payment gateway's hosted/iframe form for PCI DSS SAQ-A compliance.

**Flow:**

```
Widget                    Payment API (SPEC-04)              Gateway
  │                              │                              │
  ├─ POST /payments/intent ─────►│                              │
  │  { reservation_id,           │                              │
  │    amount_cents,             │                              │
  │    method: 'card' }          │── Create intent ────────────►│
  │                              │◄── client_secret ────────────│
  │◄── { payment_intent_id,     │                              │
  │      client_secret,          │                              │
  │      gateway: 'stripe' } ───┤                              │
  │                              │                              │
  │  [Render gateway form with client_secret]                  │
  │  [User enters card details in gateway iframe]              │
  │                              │                              │
  ├─ Gateway confirms payment ──►│                              │
  │  (via redirect or webhook)   │                              │
  │                              │                              │
  ├─ POST /booking/confirm ─────►│                              │
  │  { reservation_id,           │                              │
  │    payment_intent_id }       │                              │
  │◄── { booking confirmed } ───│                              │
```

**Payment Methods Displayed:**

```
┌──────────────────────────────────────────┐
│  Payment                                  │
│                                           │
│  How would you like to pay?              │
│                                           │
│  (●) Card (Visa, Mastercard, AMEX)       │
│  ( ) Afterpay (pay in 4 instalments)     │
│  ( ) Bank Transfer (pay before lesson)   │
│  ( ) Cash (pay instructor at lesson)     │
│                                           │
│  ─────────────────────────────────────── │
│                                           │
│  [Card payment form / gateway iframe]    │
│                                           │
│  Total: $105.00                          │
│  ⏱ Reservation expires in 7:42          │
│                                           │
│  [← Back]              [Pay $105.00 ►]  │
└──────────────────────────────────────────┘
```

**Cash/Bank Transfer:** These skip the gateway iframe. The booking is confirmed with `payment_status: 'unpaid'`. A note displays: "Please pay at the start of your lesson" (cash) or "Bank details will be sent via SMS" (bank transfer).

**Error handling:**
- `PAYMENT_FAILED`: "Payment was declined. Please try a different card or payment method."
- `RESERVATION_EXPIRED`: "Your reservation has expired. Please start again." + reset widget.
- Network error: "Connection lost. Please check your internet and try again." + retry button.

### 7.9 Step 7 — Confirmation (`Confirmation.tsx`)

**Display:**

```
┌──────────────────────────────────────────┐
│                                           │
│          ✅ Booking Confirmed!            │
│                                           │
│  ─────────────────────────────────────── │
│                                           │
│  Service:    Learner Lesson (60 min)     │
│  Date:       Monday, 2 March 2026        │
│  Time:       9:00 AM - 10:00 AM AEDT    │
│  Instructor: Rob Harrison                │
│  Amount:     $105.00                     │
│  Ref:        BK-20260302-001            │
│                                           │
│  ─────────────────────────────────────── │
│                                           │
│  📱 Check your phone — we've sent a     │
│     confirmation SMS with all the        │
│     details.                             │
│                                           │
│  📧 A confirmation email is on its way  │
│     to jane@example.com.                 │
│                                           │
│  ─────────────────────────────────────── │
│                                           │
│  What to bring to your first lesson:     │
│  • Your learner licence                  │
│  • Comfortable shoes                     │
│  • Water bottle                          │
│                                           │
│  [Book Another Lesson]  [Back to Home]   │
│                                           │
└──────────────────────────────────────────┘
```

**Side effects triggered by `POST /booking/confirm` (server-side, not the widget's concern):**
1. SMS confirmation via C18 (Notification Engine)
2. Email confirmation via Resend
3. CRM contact upsert via SPEC-05
4. Audit log entry via C14
5. Google Analytics + PostHog conversion event

**Widget responsibility:** Fire client-side analytics events:

```typescript
// PostHog
posthog.capture('booking_confirmed', {
  service_id: booking.service_id,
  service_name: booking.service_name,
  booking_value_cents: booking.price_paid_cents,
});

// GA4
gtag('event', 'purchase', {
  currency: 'AUD',
  value: booking.price_paid_cents / 100,
  items: [{ item_name: booking.service_name }],
});
```

### 7.10 Reservation Timer (`ReservationTimer.tsx`)

**Behaviour:**
- Starts when `POST /api/v1/booking/reserve` returns `expires_at`.
- Displays countdown: `"⏱ Reservation expires in M:SS"`.
- At 2 minutes remaining: text turns `text-warning`, background pulses.
- At 0: sets `reservationExpired = true`, shows dialog: "Your reservation has expired. Would you like to start again?" with "Start Over" button.
- Timer must survive step navigation (state in Zustand, not step component).

**Implementation:** `useEffect` with `setInterval(1000)`. Computes remaining seconds from `Date.now()` vs `reservationExpiresAt`. Uses `requestAnimationFrame` or `useRef` to avoid stale closure issues.

### 7.11 Error States

| Error Code | User Message | Recovery |
|------------|-------------|----------|
| `VALIDATION_ERROR` | Specific field errors highlighted inline | Fix fields, retry |
| `SERVICE_NOT_FOUND` | "This service is no longer available." | Back to Step 1 |
| `NO_AVAILABILITY` | "No available slots for this date." | Pick another date |
| `SLOT_UNAVAILABLE` | "Someone just booked this time. Please choose another." | Back to Step 3, refresh slots |
| `BOOKING_CONFLICT` | "This slot was just taken. We've refreshed available times." | Reload availability |
| `RESERVATION_EXPIRED` | "Your reservation expired. Please try again." | Reset to Step 1 |
| `PAYMENT_FAILED` | "Payment was declined. Please try another method." | Stay on Step 6 |
| `RATE_LIMITED` | "Too many attempts. Please wait a moment." | Disable form, auto-retry after delay |
| `INTERNAL_ERROR` | "Something went wrong. Please try again or call us." | Show phone number |

**All errors:** Displayed via `<Alert variant="error">` component with icon. Never show raw error codes or stack traces.

### 7.12 Analytics Events

The widget fires these events at each step for funnel tracking:

| Event | When | Properties |
|-------|------|-----------|
| `booking_widget_opened` | Widget mounts | `{ source, page_url }` |
| `booking_service_selected` | Step 1 complete | `{ service_id, service_name }` |
| `booking_date_selected` | Step 2 complete | `{ date, slots_available }` |
| `booking_time_selected` | Step 3 complete | `{ start_time, end_time }` |
| `booking_details_entered` | Step 4 complete | `{ has_licence }` (no PII) |
| `booking_voucher_applied` | Voucher success | `{ voucher_code, discount_type }` |
| `booking_reservation_created` | Reservation confirmed | `{ reservation_id }` |
| `booking_payment_started` | Payment form shown | `{ method }` |
| `booking_confirmed` | Step 7 reached | `{ booking_id, service_name, value_cents }` |
| `booking_abandoned` | Tab close or timer expire | `{ last_step, time_spent_seconds }` |

---

## 8. API Client

```typescript
// src/lib/api-client.ts

const API_BASE = '/api/v1';

class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function apiRequest<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const url = `${API_BASE}${path}`;

  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });

  const body = await res.json();

  if (!res.ok) {
    throw new ApiError(
      body.error?.code ?? 'UNKNOWN_ERROR',
      body.error?.message ?? 'An unexpected error occurred',
      res.status,
      body.error?.details
    );
  }

  return body.data as T;
}

// ---- Booking Widget API calls ----

export async function getServices(category?: string) {
  const params = category ? `?category=${category}` : '';
  return apiRequest<{ services: ServiceType[] }>(`/booking/services${params}`);
}

export async function getAvailability(
  instructorId: string,
  serviceId: string,
  dateFrom: string,
  dateTo: string
) {
  const params = new URLSearchParams({
    instructor_id: instructorId,
    service_id: serviceId,
    date_from: dateFrom,
    date_to: dateTo,
  });
  return apiRequest<{ slots: DaySlots[] }>(`/booking/availability?${params}`);
}

export async function createReservation(data: {
  instructor_id: string;
  service_id: string;
  date: string;
  start_time: string;
  contact: { first_name: string; last_name: string; phone: string; email: string };
}) {
  return apiRequest<{
    reservation_id: string;
    expires_at: string;
    booking_summary: BookingSummary;
  }>('/booking/reserve', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function validateVoucher(data: {
  code: string;
  service_id: string;
  booking_date: string;
}) {
  return apiRequest<VoucherDiscount>('/vouchers/validate', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function createPaymentIntent(data: {
  reservation_id: string;
  amount_cents: number;
  currency: string;
  method: string;
}) {
  return apiRequest<{
    payment_intent_id: string;
    client_secret: string;
    gateway: string;
  }>('/payments/intent', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function confirmBooking(data: {
  reservation_id: string;
  payment_intent_id?: string;
}) {
  return apiRequest<ConfirmedBooking>('/booking/confirm', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}
```

---

## 9. SEO Configuration

### 9.1 Sitemap (`src/app/sitemap.ts`)

```typescript
import { MetadataRoute } from 'next';

export default function sitemap(): MetadataRoute.Sitemap {
  const baseUrl = 'https://nexdriveacademy.com.au';

  return [
    { url: baseUrl,              lastModified: new Date(), changeFrequency: 'weekly',  priority: 1.0 },
    { url: `${baseUrl}/about`,   lastModified: new Date(), changeFrequency: 'monthly', priority: 0.8 },
    { url: `${baseUrl}/services`,lastModified: new Date(), changeFrequency: 'weekly',  priority: 0.9 },
    { url: `${baseUrl}/book`,    lastModified: new Date(), changeFrequency: 'weekly',  priority: 0.9 },
    { url: `${baseUrl}/faq`,     lastModified: new Date(), changeFrequency: 'monthly', priority: 0.7 },
    { url: `${baseUrl}/contact`, lastModified: new Date(), changeFrequency: 'monthly', priority: 0.7 },
    // Blog pages added dynamically in Phase 5
  ];
}
```

### 9.2 Robots (`src/app/robots.ts`)

```typescript
import { MetadataRoute } from 'next';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/api/', '/admin/', '/dashboard/'],
      },
    ],
    sitemap: 'https://nexdriveacademy.com.au/sitemap.xml',
  };
}
```

### 9.3 Root Layout Metadata

```typescript
// src/app/layout.tsx

export const metadata: Metadata = {
  metadataBase: new URL('https://nexdriveacademy.com.au'),
  title: {
    default: 'NexDrive Academy | Driving Lessons Canberra',
    template: '%s | NexDrive Academy',
  },
  description: 'Premium driving lessons in Canberra. ADI-certified instructor. ACT CBT&A compliant.',
  keywords: ['driving lessons Canberra', 'driving school ACT', 'learn to drive Canberra'],
  authors: [{ name: 'NexDrive Academy' }],
  openGraph: {
    type: 'website',
    locale: 'en_AU',
    siteName: 'NexDrive Academy',
    images: [{ url: '/images/og-default.jpg', width: 1200, height: 630 }],
  },
  twitter: {
    card: 'summary_large_image',
  },
  robots: {
    index: true,
    follow: true,
  },
  verification: {
    google: 'GOOGLE_SITE_VERIFICATION_TOKEN',
  },
};
```

### 9.4 SEO Keyword Targets

| Page | Primary Keywords | Secondary Keywords |
|------|-----------------|-------------------|
| Homepage | driving lessons Canberra, driving school Canberra | learn to drive ACT, driving instructor Canberra |
| About | ADI driving instructor Canberra, driving teacher ACT | certified driving instructor, patient driving lessons |
| Services | driving lesson prices Canberra, how much driving lessons ACT | 1 hour driving lesson cost, intensive driving lessons Canberra |
| FAQ | learner driver FAQ Canberra, CBT&A explained | how many lessons to pass, learner licence ACT |
| Book | book driving lesson Canberra, online booking driving school | driving lesson near me, available driving lessons today |
| Contact | contact driving school Canberra | driving lessons phone number ACT |

---

## 10. Performance Requirements

### 10.1 Targets (per NFR-1)

| Metric | Target | Measurement Tool |
|--------|--------|-----------------|
| Largest Contentful Paint (LCP) | < 2.5s | Lighthouse / Vercel Analytics |
| Time to Interactive (TTI) | < 3.5s | Lighthouse |
| First Input Delay (FID) | < 100ms | Web Vitals |
| Cumulative Layout Shift (CLS) | < 0.1 | Web Vitals |
| Lighthouse Performance score | ≥ 90 | Lighthouse |
| Lighthouse Accessibility score | ≥ 95 | Lighthouse |
| Lighthouse SEO score | ≥ 95 | Lighthouse |
| Booking widget first interaction | < 1s | PostHog timing |

### 10.2 Optimisation Strategies

1. **Images:** Use `next/image` with `sharp` for automatic WebP conversion, lazy loading, responsive `srcSet`. Hero image: preload with `priority` prop.
2. **Fonts:** `next/font` for zero-layout-shift font loading. Subset to Latin only.
3. **JavaScript:** Booking widget loaded via dynamic import (`next/dynamic`) — not in the initial page bundle. Only loads when user navigates to `/book` or clicks a "Book Now" CTA.
4. **API calls:** Server-side for page data (services list). Client-side only for interactive flows (availability, reservation).
5. **ISR:** Services page revalidates every 60 seconds. Static pages (about, FAQ) revalidate every hour.
6. **Third-party scripts:** PostHog and GA4 loaded with `afterInteractive` strategy via `next/script`.

---

## 11. Accessibility Requirements (WCAG 2.1 AA)

### 11.1 Global Requirements

| Requirement | Implementation |
|-------------|----------------|
| Keyboard navigation | All interactive elements focusable via Tab. Enter/Space activates. Escape closes modals/drawers. |
| Focus indicators | `focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2` on all interactive elements. |
| Colour contrast | Minimum 4.5:1 for normal text, 3:1 for large text. Verified against primary-500 on white. |
| Screen reader | All images have `alt` text. Icons have `aria-label`. Decorative images use `alt=""`. |
| ARIA landmarks | `<header>`, `<nav>`, `<main>`, `<footer>` on every page. |
| Form labels | Every input has a visible `<label>` with `htmlFor`. Error messages linked via `aria-describedby`. |
| Error announcements | Form errors announced via `role="alert"` and `aria-live="polite"`. |
| Motion | Respect `prefers-reduced-motion`. Disable animations when set. |
| Touch targets | Minimum 44×44px on mobile for all buttons, links, and interactive elements. |

### 11.2 Booking Widget Accessibility

| Feature | Implementation |
|---------|----------------|
| Step navigation | `aria-current="step"` on active step. Steps announced: "Step 2 of 7: Select date". |
| Calendar | `react-day-picker` has built-in ARIA roles. Arrow keys navigate dates. |
| Time slots | Slots as radio group (`role="radiogroup"`). Selected slot announced. |
| Timer | `aria-live="polite"` region. At 2 minutes, `aria-live="assertive"` warns "Reservation expiring soon". |
| Progress bar | `role="progressbar"` with `aria-valuenow`, `aria-valuemin`, `aria-valuemax`. |
| Error recovery | Focus moved to first error on validation failure. Clear "try again" instructions. |

---

## 12. Analytics Integration

### 12.1 PostHog Setup

```typescript
// src/lib/analytics.ts

import posthog from 'posthog-js';

export function initAnalytics() {
  if (typeof window === 'undefined') return;
  if (!process.env.NEXT_PUBLIC_POSTHOG_KEY) return;

  posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY, {
    api_host: 'https://us.i.posthog.com',
    capture_pageview: false,          // Manually capture for App Router
    capture_pageleave: true,
    persistence: 'localStorage',
  });
}

export function trackPageView(url: string) {
  posthog.capture('$pageview', { $current_url: url });
}

export function trackEvent(name: string, properties?: Record<string, unknown>) {
  posthog.capture(name, properties);
}
```

### 12.2 GA4 Setup

GA4 loaded via `next/script` with `strategy="afterInteractive"`. Conversion events fired on booking confirmation (Step 7) to track ROI of Google Ads / organic traffic.

### 12.3 Booking Funnel Dashboard

PostHog funnel: `widget_opened → service_selected → date_selected → time_selected → details_entered → reservation_created → payment_started → booking_confirmed`.

Target conversion rate: >15% (visitor to booked — industry average is 8-12%).

---

## 13. Contact Form API Route

```typescript
// src/app/api/v1/contact-form/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { Resend } from 'resend';
import { upsertFromChannel } from '@/lib/crm/auto-create.service';

const ContactFormSchema = z.object({
  name: z.string().min(2).max(100),
  email: z.string().email(),
  phone: z.string().optional(),
  message: z.string().min(10).max(2000),
});

const ratelimit = new Ratelimit({
  redis: Redis.fromEnv(),
  limiter: Ratelimit.slidingWindow(10, '1 h'),
});
const resend = new Resend(process.env.RESEND_API_KEY);

export async function POST(req: NextRequest) {
  try {
    // Rate limit by IP
    const ip = req.headers.get('x-forwarded-for') ?? 'unknown';
    const { success } = await ratelimit.limit(`contact-form:${ip}`);
    if (!success) {
      return NextResponse.json(
        { error: { code: 'RATE_LIMITED', message: 'Too many submissions. Please wait.' } },
        { status: 429 }
      );
    }

    const body = await req.json();
    const data = ContactFormSchema.parse(body);

    // Send email to Rob
    await resend.emails.send({
      from: 'NexDrive Academy <noreply@nexdriveacademy.com.au>',
      to: 'rob@nexdriveacademy.com.au',
      subject: `Contact form: ${data.name}`,
      text: `Name: ${data.name}\nEmail: ${data.email}\nPhone: ${data.phone ?? 'Not provided'}\n\nMessage:\n${data.message}`,
    });

    // Create/touch CRM contact (system auth context)
    await upsertFromChannel(
      {
        email: data.email,
        phone: data.phone,
        first_name: data.name.split(' ')[0],
        last_name: data.name.split(' ').slice(1).join(' ') || undefined,
        source: 'contact_form',
      },
      { role: 'system', clerk_user_id: 'system' } as any
    ).catch(() => {}); // Non-blocking

    return NextResponse.json({ data: { success: true } });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: 'Invalid form data', details: error.flatten() } },
        { status: 422 }
      );
    }
    console.error('[CONTACT_FORM] Error:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } },
      { status: 500 }
    );
  }
}
```

---

## 14. Utility Functions

### 14.1 Formatters (`src/lib/format.ts`)

```typescript
/**
 * Format cents to AUD currency string.
 * formatCurrency(10500) → "$105.00"
 * formatCurrency(9450)  → "$94.50"
 */
export function formatCurrency(cents: number): string {
  return new Intl.NumberFormat('en-AU', {
    style: 'currency',
    currency: 'AUD',
  }).format(cents / 100);
}

/**
 * Format AU phone number for display.
 * formatPhone('+61412345678') → '0412 345 678'
 */
export function formatPhone(e164: string): string {
  const local = e164.replace('+61', '0');
  return `${local.slice(0, 4)} ${local.slice(4, 7)} ${local.slice(7)}`;
}

/**
 * Normalise user-entered phone to E.164.
 * normalisePhone('0412 345 678') → '+61412345678'
 * normalisePhone('0412345678')   → '+61412345678'
 */
export function normalisePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('61')) return `+${digits}`;
  if (digits.startsWith('0')) return `+61${digits.slice(1)}`;
  return `+61${digits}`;
}

/**
 * Format date for display in Australia/Canberra timezone.
 * formatDate('2026-03-02') → 'Monday, 2 March 2026'
 */
export function formatDate(dateStr: string): string {
  const date = new Date(dateStr + 'T00:00:00');
  return new Intl.DateTimeFormat('en-AU', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Australia/Canberra',
  }).format(date);
}

/**
 * Format time slot for display.
 * formatTime('09:00') → '9:00 AM'
 * formatTime('14:30') → '2:30 PM'
 */
export function formatTime(time24: string): string {
  const [h, m] = time24.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return `${hour}:${m.toString().padStart(2, '0')} ${period}`;
}
```

---

## 15. Testing Requirements

### 15.1 Unit Tests

| Test Area | What to Test |
|-----------|-------------|
| Formatters | `formatCurrency`, `formatPhone`, `normalisePhone`, `formatDate`, `formatTime` — edge cases + AU-specific formats |
| Zustand store | State transitions for each step, reservation expiry logic, reset behaviour |
| Zod schemas | Contact form validation, voucher validation — valid and invalid inputs |

### 15.2 Component Tests (React Testing Library)

| Component | What to Test |
|-----------|-------------|
| `BookingWidget` | Renders Step 1 on mount, navigates between steps, shows summary sidebar |
| `ServiceSelect` | Renders service cards from API data, highlights selected, enables Continue |
| `DateSelect` | Disables past dates, calls availability API on date click |
| `TimeSelect` | Renders available slots, disables unavailable, selects slot |
| `ContactDetails` | Validates required fields, formats phone, shows errors on blur |
| `VoucherEntry` | Submits code, displays discount, handles invalid codes |
| `ReservationTimer` | Counts down, changes colour at 2 min, shows expiry dialog at 0 |
| `Confirmation` | Displays all booking details, fires analytics events |

### 15.3 E2E Tests (Playwright)

| Test | Steps |
|------|-------|
| Happy path booking | Select service → date → time → fill details → skip voucher → pay → confirm |
| Voucher flow | Enter valid code → see discount → confirm |
| Reservation expiry | Start booking → wait 10 min → see expiry dialog |
| Mobile booking | Run full flow at 375px viewport |
| SEO validation | Check meta tags, JSON-LD presence, sitemap accessibility |
| Keyboard-only booking | Complete entire flow using Tab + Enter only |

---

## 16. Deployment & Environment

### 16.1 Vercel Configuration

```json
// vercel.json
{
  "framework": "nextjs",
  "regions": ["syd1"],
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "X-Content-Type-Options", "value": "nosniff" },
        { "key": "X-Frame-Options", "value": "DENY" },
        { "key": "X-XSS-Protection", "value": "1; mode=block" },
        { "key": "Referrer-Policy", "value": "strict-origin-when-cross-origin" }
      ]
    }
  ]
}
```

### 16.2 Image Assets Required

| Asset | Dimensions | Format | Notes |
|-------|-----------|--------|-------|
| `logo.svg` | ~200×40 | SVG | Primary logo |
| `logo-dark.svg` | ~200×40 | SVG | For dark backgrounds |
| `rob-portrait.jpg` | 600×800 | JPG | Professional headshot |
| `hero-bg.jpg` | 1920×1080 | JPG | Hero section background |
| `og-default.jpg` | 1200×630 | JPG | Social sharing fallback |
| `adi-badge.svg` | 80×80 | SVG | ADI certification mark |
| `act-compliant.svg` | 80×80 | SVG | ACT compliance mark |
| `favicon.ico` | 32×32 | ICO | Browser tab icon |
| `apple-touch-icon.png` | 180×180 | PNG | iOS home screen |

---

## 17. Implementation Checklist

### Phase 1 Sprint Delivery Order

| # | Task | Est. | Dependencies |
|---|------|------|-------------|
| 1 | TailwindCSS theme + design tokens | 0.5d | None |
| 2 | UI primitives (Button, Card, Input, Alert, Spinner) | 1d | Task 1 |
| 3 | Layout components (Header, Footer, MobileNav) | 1d | Task 2 |
| 4 | Homepage (Hero, ValueProps, TrustBadges, CTABanner, InstructorIntro) | 1d | Task 3 |
| 5 | About page | 0.5d | Task 3 |
| 6 | Services page (dynamic from API) | 0.5d | Task 3, SPEC-03 services API |
| 7 | FAQ page + JSON-LD | 0.5d | Task 3 |
| 8 | Contact page + form + API route | 0.5d | Task 3, SPEC-05 CRM |
| 9 | Booking widget — Steps 1-3 (service, date, time) | 1.5d | Task 2, SPEC-03 availability API |
| 10 | Booking widget — Step 4 (contact details + reservation) | 0.5d | Task 9, SPEC-03 reserve API |
| 11 | Booking widget — Steps 5-6 (voucher + payment) | 1d | Task 10, SPEC-04 payment API |
| 12 | Booking widget — Step 7 (confirmation + analytics) | 0.5d | Task 11 |
| 13 | SEO (metadata, JSON-LD, sitemap, robots, OG tags) | 0.5d | All pages |
| 14 | Accessibility audit + fixes | 0.5d | All components |
| 15 | Performance audit + optimisation | 0.5d | All pages |

**Total: ~10 days**

---

## 18. Future Enhancements (Not Phase 1)

| Enhancement | Phase | Notes |
|-------------|-------|-------|
| Blog (MDX) | Phase 5 | SEO content strategy for Canberra driving keywords |
| Competency Hub pages | Phase 5 | 23+ task pages linked from C17 |
| Web chat widget (C04) embed | Phase 2 | Floating chat bubble on all pages |
| Multi-instructor selector in booking widget | Phase 6 | Step 2 becomes instructor → date |
| Testimonial management via admin panel | Phase 6 | Database-driven instead of hardcoded |
| A/B testing (PostHog experiments) | Phase 6 | Hero copy, CTA button text, pricing display |
| Dark mode | Future | `prefers-color-scheme` media query + Tailwind dark mode |

---

*SPEC-06 v1.0 — NexDrive Academy Frontend Implementation Brief*  
*Covers C01 (Public Website & SEO Engine) and C02 (Booking Widget)*  
*Ready for implementation by frontend developer or AI coding agent*
