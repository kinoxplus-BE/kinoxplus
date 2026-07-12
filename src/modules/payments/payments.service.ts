import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { CheckoutDto } from './dto/checkout.dto';
import { FlutterwaveProvider } from './providers/flutterwave.provider';
import { PaystackProvider } from './providers/paystack.provider';

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly paystack: PaystackProvider,
    private readonly flutterwave: FlutterwaveProvider,
  ) {}

  /** Kicks off the provider checkout; entitlement is granted by the webhook, never here. */
  checkout(userId: string, dto: CheckoutDto): Promise<never> {
    return dto.provider === 'paystack'
      ? this.paystack.initializeTransaction(userId, dto.planId)
      : this.flutterwave.initializeTransaction(userId, dto.planId);
  }
}
