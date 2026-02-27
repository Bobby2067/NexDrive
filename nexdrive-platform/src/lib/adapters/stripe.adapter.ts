import Stripe from 'stripe'
import { isLocalModeEnabled } from '@/lib/runtime'

let stripeClient: Stripe | null = null

function getStripeClient(): Stripe {
  const secretKey = process.env.STRIPE_SECRET_KEY?.trim()
  if (!secretKey) {
    throw new Error('Stripe is not configured. Set STRIPE_SECRET_KEY to enable payment flows.')
  }

  if (!stripeClient) {
    stripeClient = new Stripe(secretKey, {
      apiVersion: '2025-02-24.acacia',
    })
  }

  return stripeClient
}

export interface CheckoutParams {
  amountCents: number
  currency: 'aud'
  description: string
  successUrl: string
  cancelUrl: string
  customerEmail?: string
  metadata?: Record<string, string>
}

export interface StripeCheckoutResult {
  url: string
  sessionId: string
}

export const stripeAdapter = {
  async createCheckoutSession(params: CheckoutParams): Promise<StripeCheckoutResult> {
    if (!process.env.STRIPE_SECRET_KEY && isLocalModeEnabled()) {
      const sessionId = `mock_cs_${Date.now()}`
      return {
        url: params.successUrl.replace('{CHECKOUT_SESSION_ID}', sessionId),
        sessionId,
      }
    }

    const stripe = getStripeClient()
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: params.currency,
            unit_amount: params.amountCents,
            product_data: { name: params.description },
          },
          quantity: 1,
        },
      ],
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
      customer_email: params.customerEmail,
      metadata: params.metadata ?? {},
      payment_intent_data: {
        metadata: params.metadata ?? {},
      },
    })

    return {
      url: session.url!,
      sessionId: session.id,
    }
  },

  constructWebhookEvent(payload: string, signature: string): Stripe.Event {
    const secret = process.env.STRIPE_WEBHOOK_SECRET
    if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET is not set')
    const stripe = getStripeClient()
    return stripe.webhooks.constructEvent(payload, signature, secret)
  },

  async refund(paymentIntentId: string, amountCents?: number): Promise<void> {
    const stripe = getStripeClient()
    await stripe.refunds.create({
      payment_intent: paymentIntentId,
      ...(amountCents ? { amount: amountCents } : {}),
    })
  },

  async getSession(sessionId: string): Promise<Stripe.Checkout.Session> {
    if (!process.env.STRIPE_SECRET_KEY && isLocalModeEnabled()) {
      return {
        id: sessionId,
        metadata: {},
        payment_intent: null,
      } as Stripe.Checkout.Session
    }

    const stripe = getStripeClient()
    return stripe.checkout.sessions.retrieve(sessionId)
  },
}

export type StripeEvent = Stripe.Event
