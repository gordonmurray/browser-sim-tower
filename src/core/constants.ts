/** Grid dimensions. X is horizontal cell, Y is floor (negative = basement). */
export const GRID_WIDTH = 100;
export const MIN_FLOOR = -10;
export const MAX_FLOOR = 60;

export const MINUTES_PER_DAY = 1440;
export const DAYS_PER_QUARTER = 4;

/** Elevator tuning. */
export const ELEVATOR_CAPACITY = 15;
export const ELEVATOR_MAX_SPAN = 30;
export const ELEVATOR_SPEED_FLOORS_PER_MIN = 2;
export const ELEVATOR_STOP_MINUTES = 1;
export const ELEVATOR_SHAFT_WIDTH = 3;
export const MAX_CARS_PER_SHAFT = 4;

/** People movement. */
export const WALK_CELLS_PER_MIN = 14;
export const STAIR_MINUTES_PER_FLOOR = 2;
export const ESCALATOR_MINUTES_PER_FLOOR = 0.75;
/** Max floors a person is willing to climb via stairs for a single trip. */
export const MAX_STAIR_FLOORS = 4;
/** Minutes waiting for an elevator before a person abandons the trip. */
export const GIVE_UP_WAIT_MINUTES = 45;

/** Soft cap on simultaneously simulated people (spawning pauses above it). */
export const MAX_PEOPLE = 700;

/** How many ledger entries we keep for the finance panel. */
export const LEDGER_LIMIT = 60;
