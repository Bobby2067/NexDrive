import Stripe from 'stripe'

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error('STRIPE_SECRET_KEY is not set')
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-12-18.acacia',
})

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
    return stripe.webhooks.constructEvent(payload, signature, secret)
  },

  async refund(paymentIntentId: string, amountCents?: number): Promise<void> {
    await stripe.refunds.create({
      payment_intent: paymentIntentId,
      ...(amountCents ? { amount: amountCents } : {}),
    })
  },

  async getSession(sessionId: string): Promise<Stripe.Checkout.Session> {
    return stripe.checkout.sessions.retrieve(sessionId)
  },
}

export type StripeEvent = Stripe.Event
