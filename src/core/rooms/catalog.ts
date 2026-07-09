/**
 * Data-driven room definitions. Adding a room type means adding an entry here
 * (plus any type-specific rule predicate in rules/), not new engine branches.
 * All numbers are placeholders to tune later.
 */
import type { RoomTypeId } from '../state';

export type RoomCategory =
  | 'lobby'
  | 'office'
  | 'residence'
  | 'hotel'
  | 'retail'
  | 'support'
  | 'parking';

export interface RoomTypeDef {
  id: RoomTypeId;
  name: string;
  category: RoomCategory;
  w: number;
  h: number;
  cost: number;
  starRequired: 1 | 2 | 3 | 4 | 5;
  /** Floor placement constraints. */
  groundOnly?: boolean;
  aboveGroundOnly?: boolean;
  basementOnly?: boolean;
  notOnGround?: boolean;
  /** People counted toward population while occupied. */
  people: number;
  noisy?: boolean;
  noiseSensitive?: boolean;
  rentPerQuarter?: number;
  salePrice?: number;
  nightlyRate?: number;
  incomePerVisit?: number;
  upkeepPerQuarter?: number;
  openHour?: number;
  closeHour?: number;
  desc: string;
}

export const ROOM_CATALOG: Record<RoomTypeId, RoomTypeDef> = {
  lobby: {
    id: 'lobby', name: 'Lobby', category: 'lobby', w: 4, h: 1, cost: 500,
    starRequired: 1, groundOnly: true, people: 0,
    desc: 'Entrance hall on the ground floor. Everyone enters the tower here. Drag to build wider.',
  },
  office: {
    id: 'office', name: 'Office', category: 'office', w: 6, h: 1, cost: 4000,
    starRequired: 1, aboveGroundOnly: true, people: 6, rentPerQuarter: 1500,
    desc: 'Rents to a business every quarter. Workers commute on weekdays and hate long elevator waits.',
  },
  condo: {
    id: 'condo', name: 'Condo', category: 'residence', w: 8, h: 1, cost: 8000,
    starRequired: 1, aboveGroundOnly: true, people: 3, salePrice: 13000, noiseSensitive: true,
    desc: 'Sold once for a lump sum. Residents stay long-term unless satisfaction collapses.',
  },
  fastfood: {
    id: 'fastfood', name: 'Fast Food', category: 'retail', w: 6, h: 1, cost: 2500,
    starRequired: 1, notOnGround: true, people: 0, incomePerVisit: 12,
    upkeepPerQuarter: 300, openHour: 7, closeHour: 22, noisy: true,
    desc: 'Cheap eats. Earns per customer; feeds office workers at lunch. Noisy neighbour.',
  },
  shop: {
    id: 'shop', name: 'Shop', category: 'retail', w: 4, h: 1, cost: 3000,
    starRequired: 2, notOnGround: true, people: 0, incomePerVisit: 25,
    upkeepPerQuarter: 350, openHour: 10, closeHour: 20,
    desc: 'Retail store. Earns per customer visit; busier at weekends.',
  },
  restaurant: {
    id: 'restaurant', name: 'Restaurant', category: 'retail', w: 10, h: 1, cost: 6000,
    starRequired: 3, notOnGround: true, people: 0, incomePerVisit: 45,
    upkeepPerQuarter: 600, openHour: 17, closeHour: 23, noisy: true,
    desc: 'Evening dining. High income per visit, but a noisy neighbour.',
  },
  hotelSingle: {
    id: 'hotelSingle', name: 'Hotel Single', category: 'hotel', w: 3, h: 1, cost: 3000,
    starRequired: 2, aboveGroundOnly: true, people: 1, nightlyRate: 150, noiseSensitive: true,
    desc: 'One guest per night. Needs housekeeping within 10 floors to be cleaned after checkout.',
  },
  hotelDouble: {
    id: 'hotelDouble', name: 'Hotel Double', category: 'hotel', w: 5, h: 1, cost: 5000,
    starRequired: 2, aboveGroundOnly: true, people: 2, nightlyRate: 260, noiseSensitive: true,
    desc: 'Two guests per night. Needs housekeeping within 10 floors.',
  },
  hotelSuite: {
    id: 'hotelSuite', name: 'Hotel Suite', category: 'hotel', w: 8, h: 1, cost: 10000,
    starRequired: 3, aboveGroundOnly: true, people: 3, nightlyRate: 550, noiseSensitive: true,
    desc: 'Luxury suite. Premium nightly rate; picky about noise and waits.',
  },
  housekeeping: {
    id: 'housekeeping', name: 'Housekeeping', category: 'support', w: 4, h: 1, cost: 2000,
    starRequired: 2, notOnGround: true, people: 0, upkeepPerQuarter: 300,
    desc: 'Cleans up to 8 hotel rooms per day within 10 floors. Hotels cannot re-rent dirty rooms.',
  },
  security: {
    id: 'security', name: 'Security', category: 'support', w: 6, h: 1, cost: 5000,
    starRequired: 2, notOnGround: true, people: 0, upkeepPerQuarter: 500,
    desc: 'Keeps tenants happy: +satisfaction for rooms within 15 floors.',
  },
  medical: {
    id: 'medical', name: 'Medical Clinic', category: 'support', w: 8, h: 1, cost: 10000,
    starRequired: 3, notOnGround: true, people: 0, upkeepPerQuarter: 1000,
    desc: 'On-site clinic: +satisfaction for rooms within 15 floors.',
  },
  recycling: {
    id: 'recycling', name: 'Recycling Centre', category: 'support', w: 10, h: 1, cost: 8000,
    starRequired: 3, basementOnly: true, people: 0, upkeepPerQuarter: 600,
    desc: 'Handles the tower’s waste. At 3★+ a large tower without one upsets everyone.',
  },
  parking: {
    id: 'parking', name: 'Parking', category: 'parking', w: 6, h: 1, cost: 1500,
    starRequired: 1, basementOnly: true, people: 0, upkeepPerQuarter: 100,
    desc: 'Basement parking (4 spaces). Makes offices lease faster and retail busier.',
  },
};

/** Spaces provided per parking room. */
export const PARKING_SPACES_PER_ROOM = 4;

/** Population needed to reach star (index 0 = 1 star). */
export const STAR_THRESHOLDS = [0, 80, 300, 900, 2200];
/** Max floor above ground allowed per star (index 0 = 1 star). */
export const MAX_FLOOR_BY_STAR = [10, 20, 35, 50, 60];
/** Deepest basement floor allowed per star. */
export const MIN_FLOOR_BY_STAR = [-2, -3, -5, -8, -10];

export const BALANCE = {
  startingMoney: 100_000,
  structureCostPerCell: 30,
  demolishRefund: 0,
  elevatorBaseCost: 2000,
  elevatorCostPerFloor: 300,
  elevatorCarCost: 1000,
  elevatorCarsIncluded: 2,
  elevatorUpkeepPerCarQuarter: 100,
  stairsCost: 500,
  escalatorCost: 2000,
  escalatorUpkeepPerQuarter: 50,
  /** Chance per business HOUR a vacant reachable office leases (weekdays 8-17). */
  officeLeaseChancePerHour: 0.06,
  /** Chance per hour (9-19, any day) a vacant reachable condo sells. */
  condoSaleChancePerHour: 0.035,
  /** Chance an occupied room moves out per day when satisfaction is critical. */
  officeMoveOutChance: 0.15,
  condoMoveOutChance: 0.1,
  officeMoveOutBelow: 30,
  condoMoveOutBelow: 25,
  /** Hotel booking base chance at 19:00 (weekday / weekend). */
  hotelBookWeekday: 0.55,
  hotelBookWeekend: 0.85,
  hotelCheckInHour: 19,
  hotelCheckOutHour: 8,
  housekeepingRadius: 10,
  housekeepingRoomsPerDay: 8,
  supportRadius: 15,
  supportBonus: 5,
  /** Retail customers per open hour at baseline. */
  retailBaseRate: { fastfood: 5, shop: 3, restaurant: 3.5 } as Record<string, number>,
  weekendRetailBoost: 1.5,
  /** Recycling requirement: one centre per this much population at 3 stars and up. */
  recyclingPopPerCentre: 1500,
  recyclingPenalty: 10,
  parkingOfficeBonus: 0.3,
  parkingRetailBoost: 1.2,
} as const;
