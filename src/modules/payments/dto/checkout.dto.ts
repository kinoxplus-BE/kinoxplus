import { IsIn, IsString } from 'class-validator';

export class CheckoutDto {
  @IsString()
  planId!: string;

  /** Web flow only — mobile digital subs go through store IAP (AGENTS.md §0). */
  @IsIn(['paystack', 'flutterwave'])
  provider!: 'paystack' | 'flutterwave';
}
