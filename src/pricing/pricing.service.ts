import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PricingRule, VehicleType } from '@prisma/client';
import { estimateRoadDistanceKm, round2 } from '../common/geo.util';
import { ResponsesService } from '../common/responses/responses.service';
import {
  ServiceResult,
  badRequest,
  notFound,
  ok,
} from '../common/responses/response.types';
import { PrismaService } from '../prisma/prisma.service';
import { FareEstimateDto, UpdatePricingRuleDto, UpsertPricingRuleDto } from './dto/pricing.dto';
import { DEFAULT_PRICING, FARE_ROUNDING_STEP } from './pricing.constants';

export interface FareQuote {
  vehicleType: VehicleType;
  currency: string;
  distanceKm: number;
  durationMins: number;
  fare: number;
  platformFee: number;
  driverEarnings: number;
  breakdown: {
    baseFare: number;
    distanceCharge: number;
    timeCharge: number;
    bookingFee: number;
    surgeMultiplier: number;
    minimumFareApplied: boolean;
  };
}

@Injectable()
export class PricingService implements OnModuleInit {
  private readonly logger = new Logger(PricingService.name);

  constructor(
    private prisma: PrismaService,
    private response: ResponsesService,
  ) {}

  async onModuleInit() {
    try {
      await this.ensureDefaults();
    } catch (e: any) {
      // A cold database must not stop the app from booting.
      this.logger.warn(`Could not seed default pricing rules: ${e?.message}`);
    }
  }

  /** Creates a rule for every vehicle type that does not have one yet. */
  async ensureDefaults() {
    const existing = await this.prisma.pricingRule.findMany({ select: { vehicleType: true } });
    const present = new Set(existing.map((rule) => rule.vehicleType));
    const missing = Object.values(VehicleType).filter((type) => !present.has(type));

    if (missing.length === 0) return;

    await this.prisma.pricingRule.createMany({
      data: missing.map((vehicleType) => ({ vehicleType, ...DEFAULT_PRICING[vehicleType] })),
      skipDuplicates: true,
    });
    this.logger.log(`Seeded default pricing for: ${missing.join(', ')}`);
  }

  async findAll(options: { activeOnly?: boolean } = {}): Promise<ServiceResult> {
    try {
      const rules = await this.prisma.pricingRule.findMany({
        where: options.activeOnly ? { isActive: true } : undefined,
        orderBy: { vehicleType: 'asc' },
      });
      return ok(rules);
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  async findOne(vehicleType: VehicleType): Promise<ServiceResult> {
    try {
      const rule = await this.prisma.pricingRule.findUnique({ where: { vehicleType } });
      if (!rule) return notFound(`No pricing rule for ${vehicleType}`);
      return ok(rule);
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  async upsert(vehicleType: VehicleType, dto: UpsertPricingRuleDto): Promise<ServiceResult> {
    try {
      const rule = await this.prisma.pricingRule.upsert({
        where: { vehicleType },
        create: { vehicleType, ...dto },
        update: dto,
      });
      return ok(rule);
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  async update(vehicleType: VehicleType, dto: UpdatePricingRuleDto): Promise<ServiceResult> {
    try {
      const existing = await this.prisma.pricingRule.findUnique({ where: { vehicleType } });
      if (!existing) return notFound(`No pricing rule for ${vehicleType}`);

      const rule = await this.prisma.pricingRule.update({ where: { vehicleType }, data: dto });
      return ok(rule);
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  /**
   * Rule used for money decisions — inactive types cannot be booked. Returns a
   * ServiceResult so callers propagate the right status rather than a 500.
   */
  async getActiveRule(vehicleType: VehicleType): Promise<ServiceResult<PricingRule | string>> {
    try {
      const rule = await this.prisma.pricingRule.findUnique({ where: { vehicleType } });

      if (!rule) return badRequest(`Pricing is not configured for ${vehicleType}`);
      if (!rule.isActive) return badRequest(`${vehicleType} is not available for booking`);

      return ok(rule);
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  async estimate(dto: FareEstimateDto): Promise<ServiceResult<FareQuote | string>> {
    try {
      const ruleResult = await this.getActiveRule(dto.vehicleType as VehicleType);
      if (ruleResult.error) return ruleResult as ServiceResult<string>;

      const distanceKm = estimateRoadDistanceKm(
        dto.pickupLat,
        dto.pickupLng,
        dto.dropoffLat,
        dto.dropoffLng,
      );

      return ok(this.quoteFromRule(ruleResult.body as PricingRule, distanceKm));
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  /** Quotes every bookable vehicle type on one route — powers the ride-picker screen. */
  async estimateAll(dto: Omit<FareEstimateDto, 'vehicleType'>): Promise<ServiceResult> {
    try {
      const rules = await this.prisma.pricingRule.findMany({ where: { isActive: true } });
      const distanceKm = estimateRoadDistanceKm(
        dto.pickupLat,
        dto.pickupLng,
        dto.dropoffLat,
        dto.dropoffLng,
      );

      return ok(rules.map((rule) => this.quoteFromRule(rule, distanceKm)));
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  /** Pure arithmetic — no I/O, so it returns the quote directly. */
  quoteFromRule(rule: PricingRule, distanceKm: number): FareQuote {
    const durationMins = round2((distanceKm / Math.max(rule.avgSpeedKph, 1)) * 60);

    const distanceCharge = rule.perKm * distanceKm;
    const timeCharge = rule.perMinute * durationMins;

    const raw = rule.baseFare + distanceCharge + timeCharge;
    const minimumFareApplied = raw < rule.minimumFare;
    const subtotal = Math.max(raw, rule.minimumFare);

    const fare = roundUpTo(subtotal * rule.surgeMultiplier + rule.bookingFee, FARE_ROUNDING_STEP);
    const platformFee = Math.round((fare * rule.platformFeePercent) / 100);

    return {
      vehicleType: rule.vehicleType,
      currency: rule.currency,
      distanceKm,
      durationMins,
      fare,
      platformFee,
      driverEarnings: fare - platformFee,
      breakdown: {
        baseFare: rule.baseFare,
        distanceCharge: round2(distanceCharge),
        timeCharge: round2(timeCharge),
        bookingFee: rule.bookingFee,
        surgeMultiplier: rule.surgeMultiplier,
        minimumFareApplied,
      },
    };
  }
}

function roundUpTo(value: number, step: number): number {
  if (step <= 1) return Math.round(value);
  return Math.ceil(value / step) * step;
}
