import { Module } from '@nestjs/common';

/**
 * [POST-MVP] pgvector-based recommendations (AGENTS.md §15).
 * Structure exists so migrations/imports don't churn later — do not build
 * until the Watch Room is validated in production.
 */
@Module({})
export class RecommendationsModule {}
