import { headers } from 'next/headers'
import { NextResponse } from 'next/server'
import { stripeAdapter } from '@/lib/adapters/stripe.adapter'
import { handlePaymentSuccess } from '@/lib/services/payment.service'
import { db } from '@/lib/db'
import { payments, auditLog } from '@/lib/schema'
import { eq } from 'drizzle-orm'

export async function POST(req: Request) {
  const body = await req.text()
  const headersList = await headers()
  const signature = headersList.get('stripe-signature')

  if (!signature) {
    return NextResponse.json({ error: 'Missing stripe-signature header' }, { status: 400 })
  }

  let event
  try {
    event = stripeAdapter.constructWebhookEvent(body, signature)
  } catch (err) {
    console.error('Stripe webhook signature verification failed:', err)
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as { id: string }
        await handlePaymentSuccess(session.id)
        break
      }

      case 'payment_intent.payment_failed': {
        const intent = event.data.object as { id: string }
        await db
          .update(payments)
          .set({ status: 'failed', updatedAt: new Date() })
          .where(eq(payments.providerRef, intent.id))

        await db.insert(auditLog).values({
          action: 'PAYMENT_FAILED',
          entityType: 'payment',
          entityId: intent.id,
          payload: { stripeEventId: event.id },
        })
        break
      }

      case 'charge.refunded': {
        const charge = event.data.object as { payment_intent: string }
        await db.insert(auditLog).values({
          action: 'CHARGE_REFUNDED',
          entityType: 'payment',
          entityId: charge.payment_intent,
          payload: { stripeEventId: event.id },
        })
        break
      }

      default:
        // Unhandled event type — log and ignore
        console.log(`Unhandled Stripe event: ${event.type}`)
    }

    return NextResponse.json({ received: true })
  } catch (err) {
    console.error('Stripe webhook processing error:', err)
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 })
  }
}