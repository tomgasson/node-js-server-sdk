import LogEventProcessor from './LogEventProcessor';
import { StatsigOptions } from './StatsigOptions';
import { ExhaustSwitchError } from './utils/core';

export const MAX_SAMPLING_RATE = 10000;
export const MAX_MARKER_COUNT = 26;
export interface Marker {
  markerID?: string;
  key: KeyType;
  action: ActionType;
  timestamp: number;
  step?: StepType;
  statusCode?: number;
  error?: Record<string, unknown>;
  success?: boolean;
  url?: string;
  idListCount?: number;
  reason?: 'timeout';
  sdkRegion?: string | null;
  configName?: string;
}
export type DiagnosticsSamplingRate = {
  dcs: number;
  log: number;
  idlist: number;
  initialize: number;
  api_call: number;
  gcir: number;
};

export type SDKConstants = DiagnosticsSamplingRate;

export type ContextType =
  | 'initialize'
  | 'config_sync'
  | 'event_logging'
  | 'api_call'
  | 'get_client_initialize_response';
export type KeyType =
  | 'download_config_specs'
  | 'bootstrap'
  | 'get_id_list'
  | 'get_id_list_sources'
  | 'get_config'
  | 'get_experiment'
  | 'check_gate'
  | 'get_layer'
  | 'get_client_initialize_response'
  | 'overall';
export type StepType = 'process' | 'network_request';
export type ActionType = 'start' | 'end';

type DiagnosticsMarkers = {
  initialize: Marker[];
  config_sync: Marker[];
  event_logging: Marker[];
  api_call: Marker[];
  get_client_initialize_response: Marker[];
};

export class DiagnosticsImpl {
  readonly mark = {
    overall: this.selectAction<OverrallDataType>('overall'),
    downloadConfigSpecs: this.selectStep<DCSDataType>('download_config_specs'),
    bootstrap: this.selectStep<BootstrapDataType>('bootstrap'),
    getIDList: this.selectStep<GetIDListDataType>('get_id_list'),
    getIDListSources: this.selectStep<GetIdListSourcesDataType>(
      'get_id_list_sources',
    ),
    getClientInitializeResponse:
      this.selectAction<GetClientInitializeResponseDataType>(
        'get_client_initialize_response',
        'process',
      ),
    api_call: (tag: string) => {
      switch (tag) {
        case 'getConfig':
          return this.selectAction<ApiCallDataType>('get_config');
        case 'getExperiment':
          return this.selectAction<ApiCallDataType>('get_experiment');
        case 'checkGate':
          return this.selectAction<ApiCallDataType>('check_gate');
        case 'getLayer':
          return this.selectAction<ApiCallDataType>('get_layer');
      }
      return null;
    },
  };

  private readonly markers: DiagnosticsMarkers = {
    initialize: [],
    config_sync: [],
    event_logging: [],
    api_call: [],
    get_client_initialize_response: [],
  };

  private disabledCoreAPI: boolean;
  private logger: LogEventProcessor;
  private context: ContextType = 'initialize';
  private samplingRates: SDKConstants = {
    dcs: 0,
    log: 0,
    idlist: 0,
    initialize: MAX_SAMPLING_RATE,
    api_call: 0,
    gcir: 0,
  };

  constructor(args: {
    logger: LogEventProcessor;
    options?: StatsigOptions;
    markers?: DiagnosticsMarkers;
  }) {
    this.markers = args.markers ?? {
      initialize: [],
      config_sync: [],
      event_logging: [],
      api_call: [],
      get_client_initialize_response: [],
    };
    this.logger = args.logger;
    this.disabledCoreAPI = args.options?.disableDiagnostics ?? false;
  }

  setContext(context: ContextType) {
    this.context = context;
  }

  setSamplingRate(samplingRate: unknown) {
    this.updateSamplingRates(samplingRate);
  }

  selectAction<ActionType extends RequiredStepTags>(
    key: KeyType,
    step?: StepType,
  ) {
    type StartType = ActionType['start'];
    type EndType = ActionType['end'];

    return {
      start: (data: StartType, context?: ContextType): void => {
        this.addMarker(
          {
            key,
            step,
            action: 'start',
            timestamp: Date.now(),
            ...(data ?? {}),
          },
          context,
        );
      },
      end: (data: EndType, context?: ContextType): void => {
        this.addMarker(
          {
            key,
            step,
            action: 'end',
            timestamp: Date.now(),
            ...(data ?? {}),
          },
          context,
        );
      },
    };
  }

  selectStep<StepType extends RequiredMarkerTags>(key: KeyType) {
    type ProcessStepType = StepType['process'];
    type NetworkRequestStepType = StepType['networkRequest'];

    return {
      process: this.selectAction<ProcessStepType>(key, 'process'),
      networkRequest: this.selectAction<NetworkRequestStepType>(
        key,
        'network_request',
      ),
    };
  }

  addMarker(marker: Marker, overrideContext?: ContextType) {
    const context = overrideContext ?? this.context;
    if (this.disabledCoreAPI && context == 'api_call') {
      return;
    }
    if (this.getMarkerCount(context) >= MAX_MARKER_COUNT) {
      return;
    }
    this.markers[context].push(marker);
  }

  getMarker(context: ContextType) {
    return this.markers[context];
  }

  clearMarker(context: ContextType) {
    this.markers[context] = [];
  }

  getMarkerCount(context: ContextType) {
    return this.markers[context].length;
  }

  logDiagnostics(
    context: ContextType,
    optionalArgs?: {
      type:
        | 'id_list'
        | 'config_spec'
        | 'initialize'
        | 'api_call'
        | 'get_client_initialize_response';
    },
  ) {
    if (this.disabledCoreAPI && context == 'api_call') {
      return;
    }

    const shouldLog = !optionalArgs
      ? true
      : this.getShouldLogDiagnostics(optionalArgs.type);

    if (shouldLog) {
      this.logger.logDiagnosticsEvent({
        context,
        markers: this.markers[context],
      });
    }
    this.markers[context] = [];
  }

  private updateSamplingRates(obj: any) {
    if (!obj || typeof obj !== 'object') {
      return;
    }
    this.safeSet(this.samplingRates, 'dcs', obj['dcs']);
    this.safeSet(this.samplingRates, 'idlist', obj['idlist']);
    this.safeSet(this.samplingRates, 'initialize', obj['initialize']);
    this.safeSet(this.samplingRates, 'log', obj['log']);
    this.safeSet(this.samplingRates, 'api_call', obj['api_call']);
    this.safeSet(this.samplingRates, 'gcir', obj['gcir']);
  }

  private safeSet(
    samplingRates: DiagnosticsSamplingRate,
    key: keyof DiagnosticsSamplingRate,
    value: unknown,
  ) {
    if (typeof value !== 'number') {
      return;
    }
    if (value < 0) {
      samplingRates[key] = 0;
    } else if (value > MAX_SAMPLING_RATE) {
      samplingRates[key] = MAX_SAMPLING_RATE;
    } else {
      samplingRates[key] = value;
    }
  }

  getShouldLogDiagnostics(
    type:
      | 'id_list'
      | 'config_spec'
      | 'initialize'
      | 'api_call'
      | 'get_client_initialize_response',
  ): boolean {
    const rand = Math.random() * MAX_SAMPLING_RATE;
    switch (type) {
      case 'id_list':
        return rand < this.samplingRates.idlist;
      case 'config_spec':
        return rand < this.samplingRates.dcs;
      case 'initialize':
        return rand < this.samplingRates.initialize;
      case 'api_call':
        return rand < this.samplingRates.api_call;
      case 'get_client_initialize_response':
        return rand < this.samplingRates.gcir;
      default:
        throw new ExhaustSwitchError(type);
    }
  }
}

export default abstract class Diagnostics {
  public static mark: DiagnosticsImpl['mark'];
  public static instance: DiagnosticsImpl;

  static initialize(args: {
    logger: LogEventProcessor;
    options?: StatsigOptions;
    markers?: DiagnosticsMarkers;
  }) {
    this.instance = new DiagnosticsImpl(args);
    this.mark = this.instance.mark;
  }

  static logDiagnostics(
    context: ContextType,
    optionalArgs?: {
      type:
        | 'id_list'
        | 'config_spec'
        | 'initialize'
        | 'api_call'
        | 'get_client_initialize_response';
    },
  ) {
    this.instance.logDiagnostics(context, optionalArgs);
  }

  static setContext(context: ContextType) {
    this.instance.setContext(context);
  }

  static formatNetworkError(e: unknown): Record<string, unknown> | undefined {
    if (!(e && typeof e === 'object')) {
      return;
    }
    return {
      code: safeGetField(e, 'code'),
      name: safeGetField(e, 'name'),
      message: safeGetField(e, 'message'),
    };
  }

  static getMarkerCount(context: ContextType) {
    return this.instance.getMarkerCount(context);
  }
}

function safeGetField(data: object, field: string): unknown | undefined {
  if (field in data) {
    return (data as Record<string, unknown>)[field];
  }
  return undefined;
}

type RequiredActionTags = {
  [K in keyof Marker]?: Marker[K];
};

interface RequiredStepTags {
  start: RequiredActionTags;
  end: RequiredActionTags;
}

interface RequiredMarkerTags {
  process: RequiredStepTags;
  networkRequest: RequiredStepTags;
}

interface OverrallDataType extends RequiredStepTags {
  overall: {
    start: Record<string, never>;
    end: {
      success: boolean;
      reason?: 'timeout';
    };
  };
}

interface DCSDataType extends RequiredMarkerTags {
  process: {
    start: Record<string, never>;
    end: {
      success: boolean;
    };
  };
  networkRequest: {
    start: Record<string, never>;
    end: {
      success: boolean;
      sdkRegion?: string | null;
      statusCode?: number;
      error?: Record<string, unknown>;
    };
  };
}

interface GetIDListDataType extends RequiredMarkerTags {
  process: {
    start: { markerID: string };
    end: {
      success: boolean;
      markerID: string;
    };
  };
  networkRequest: {
    start: {
      url: string;
      markerID: string;
    };
    end: {
      success: boolean;
      statusCode?: number;
      sdkRegion?: string | null;
      markerID: string;
    };
  };
}
interface GetIdListSourcesDataType extends RequiredMarkerTags {
  process: {
    start: {
      idListCount: number;
    };
    end: {
      success: boolean;
    };
  };
  networkRequest: {
    start: Record<string, never>;
    end: {
      success: boolean;
      sdkRegion?: string | null;
      statusCode?: number;
      error?: Record<string, unknown>;
    };
  };
}

interface BootstrapDataType extends RequiredMarkerTags {
  process: {
    start: Record<string, never>;
    end: {
      success: boolean;
    };
  };
}

interface ApiCallDataType extends RequiredStepTags {
  errorBoundary: {
    start: {
      markerID: string;
    };
    end: {
      markerID: string;
      success: boolean;
      configName: string;
    };
  };
}

interface GetClientInitializeResponseDataType extends RequiredStepTags {
  process: {
    start: {
      markerID: string;
    };
    end: {
      markerID: string;
      success: boolean;
    };
  };
}
