import { Injectable } from '@nestjs/common';
import { Observable, Subject, filter } from 'rxjs';

export type RideEventName =
  | 'order.created'
  | 'order.accepted'
  | 'order.status-changed'
  | 'order.cancelled'
  | 'order.message'
  | 'order.rated'
  | 'ride-request.created'
  | 'ride-request.bid'
  | 'ride-request.bid-accepted'
  | 'ride-request.cancelled'
  | 'ride-request.expired'
  /** A driver went online, or moved while online — triggers the backfill sweep. */
  | 'driver.available'
  /** An admin cleared or rejected a driver's documents. */
  | 'driver.kyc-updated';

export interface RideEvent<T = any> {
  name: RideEventName;
  payload: T;
}

/**
 * In-process event bus decoupling HTTP services from the WebSocket gateway:
 * services publish, the gateway subscribes and fans out to Socket.IO rooms.
 * Cross-instance delivery is handled by the Redis Streams adapter, not here.
 */
@Injectable()
export class RideEventsService {
  private readonly subject = new Subject<RideEvent>();

  emit<T>(name: RideEventName, payload: T): void {
    this.subject.next({ name, payload });
  }

  on<T>(name: RideEventName): Observable<RideEvent<T>> {
    return this.subject.asObservable().pipe(filter((event) => event.name === name));
  }

  get stream(): Observable<RideEvent> {
    return this.subject.asObservable();
  }
}
