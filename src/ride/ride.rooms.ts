/** Personal channel for any authenticated user. */
export const userRoom = (userId: string) => `user:${userId}`;

/** Personal channel for a driver — ride offers land here. */
export const driverRoom = (driverId: string) => `driver:${driverId}`;

/** Both parties of an active trip. */
export const rideRoom = (orderId: string) => `ride:${orderId}`;

/** Everyone watching one driver move on the map. */
export const driverWatchRoom = (driverId: string) => `driver-watch:${driverId}`;

/** Passenger plus every driver bidding on a request. */
export const requestRoom = (requestId: string) => `request:${requestId}`;
