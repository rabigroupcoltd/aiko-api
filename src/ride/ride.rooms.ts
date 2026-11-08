export const userRoom = (userId: string) => `user:${userId}`;

export const driverRoom = (driverId: string) => `driver:${driverId}`;

export const rideRoom = (orderId: string) => `ride:${orderId}`;

export const driverWatchRoom = (driverId: string) => `driver-watch:${driverId}`;

/** Every connected admin. Gets the whole platform's order and rider feed. */
export const ADMIN_ROOM = 'admin';

export const requestRoom = (requestId: string) => `request:${requestId}`;
