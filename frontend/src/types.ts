export type BroadbandTechnology = 'FTTP' | 'FTTC' | 'ADSL' | 'None';


export interface BroadbandResult {
  postcode: string;
  place?: string;
  scenario?: string;
  maxDownloadMbps: number;
  maxUploadMbps: number;
  technology: BroadbandTechnology;
  technologyLabel: string;
  availabilityPercent: number;
}


export interface DemoEntry extends Partial<BroadbandResult> {
  error?: {
    status: number;
    message: string;
  };
}


export class LookupError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'LookupError';
    this.status = status;
  }
}


export interface PostcodesIoLookup {
  status: number;
  result: {
    postcode: string;
    country: string;
    region: string | null;
    admin_district: string | null;
    admin_ward: string | null;
    parish: string | null;
    latitude: number;
    longitude: number;
  } | null;
}

export interface PostcodesIoAutocomplete {
  status: number;
  result: string[] | null;
}
