import { Injectable } from '@nestjs/common';
import { Observable, Subject, filter } from 'rxjs';

export type RideEventName =
  | 'order.created'
  | 'order.accepted'
  | 'order.status-changed'
  | 'order.cancelled'
  | 'order.message'
  | 'order.messages-read'
  | 'order.rated'
  | 'order.available'
  | 'order.reserved'
  | 'order.picked-up'
  | 'order.delivered'
  | 'order.no-driver-found'
  | 'ride-request.created'
  | 'ride-request.bid'
  | 'ride-request.bid-accepted'
  | 'ride-request.cancelled'
  | 'ride-request.expired'
  | 'driver.available'
  | 'driver.location'
  | 'driver.kyc-updated'
  | 'driver.went-dark';

export interface RideEvent<T = any> {
  name: RideEventName;
  payload: T;
}

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
