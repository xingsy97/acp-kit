import type {
  AuthMethod,
  CreateTerminalRequest,
  CreateTerminalResponse,
  KillTerminalRequest,
  KillTerminalResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
  RequestPermissionRequest,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from '@agentclientprotocol/sdk';

export type PermissionDecision = 'allow_once' | 'allow_always' | 'deny';

export interface RuntimeLogEvent {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  context?: Record<string, unknown>;
}

export interface RuntimePermissionRequest {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
  options: Array<{
    optionId?: string;
    name?: string;
    kind?: string;
  }>;
  raw: RequestPermissionRequest;
}

export interface RuntimeAuthSelectionRequest {
  methods: AuthMethod[];
}

export interface RuntimeHost {
  chooseAuthMethod?(request: RuntimeAuthSelectionRequest): Promise<string | null>;
  requestPermission?(request: RuntimePermissionRequest): Promise<PermissionDecision>;
  readTextFile?(params: ReadTextFileRequest): Promise<ReadTextFileResponse>;
  writeTextFile?(params: WriteTextFileRequest): Promise<WriteTextFileResponse>;
  createTerminal?(params: CreateTerminalRequest): Promise<CreateTerminalResponse>;
  terminalOutput?(params: TerminalOutputRequest): Promise<TerminalOutputResponse>;
  waitForTerminalExit?(params: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse>;
  killTerminal?(params: KillTerminalRequest): Promise<KillTerminalResponse>;
  releaseTerminal?(params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse>;
  log?(entry: RuntimeLogEvent): void;
}
