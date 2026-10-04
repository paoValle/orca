/**
 * One SSH forward per managed environment, owned across reconnects and host resume, and the
 * serving check that starts a stopped server behind it.
 */
import {
  getRuntimeSshAccess,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import type { SshTarget } from '../../shared/ssh-types'
import { getManagedOrcadFenceEnvironmentId } from '../../shared/managed-orcad-ssh-owner'
import type { SshConnection } from './ssh-connection'
import type { SshConnectionManager } from './ssh-connection-manager'
import { SshPortForwardManager } from './ssh-port-forward'
import { OrcadManagedTunnelTransportProvider } from './orcad-managed-tunnel-transport'
import {
  OrcadManagedTunnelResumeRecovery,
  type ActiveOrcadTunnel,
  type OrcadManagedServingCheck,
  type OrcadManagedTunnelProbe,
  type OrcadManagedTunnelResumeOptions
} from './orcad-managed-tunnel-resume'
import type { OrcadManagedServing } from './orcad-managed-serving'
import { checkManagedTunnelServing, type OrcadTunnelServing } from './orcad-managed-tunnel-serving'
import type { getSshTargetRegistryStore } from './ssh-target-registry'
import {
  environmentForwardChecks,
  forwardToVerifiedOrcad,
  PERSISTED_PORT_TARGETING,
  type OrcadManagedTunnelTargeting,
  type OrcadTunnelStartChecks
} from './orcad-managed-tunnel-target'

export type OrcadManagedTunnelDependencies = {
  getConnectionManager: () => SshConnectionManager | null
  getTargetStore: () => ReturnType<typeof getSshTargetRegistryStore>
  forwardManager?: SshPortForwardManager
  probeTunnel?: OrcadManagedTunnelProbe
  targeting?: OrcadManagedTunnelTargeting
  /** Runs after a fresh forward is up; starts a server that stopped (e.g. after idling). */
  ensureServing?: OrcadManagedServingCheck
}

export class OrcadManagedTunnelManager {
  private readonly active = new Map<string, ActiveOrcadTunnel>()
  private readonly inFlight = new Map<string, Promise<void>>()
  private readonly ownershipGenerations = new Map<string, number>()
  private readonly forwards: SshPortForwardManager
  private readonly resumeRecovery: OrcadManagedTunnelResumeRecovery
  private readonly targeting: OrcadManagedTunnelTargeting
  private managerGeneration = 0

  constructor(private readonly dependencies: OrcadManagedTunnelDependencies) {
    this.forwards =
      dependencies.forwardManager ??
      new SshPortForwardManager({}, [new OrcadManagedTunnelTransportProvider()])
    this.targeting = dependencies.targeting ?? PERSISTED_PORT_TARGETING
    this.resumeRecovery = new OrcadManagedTunnelResumeRecovery({
      active: this.active,
      forwards: this.forwards,
      getConnectionManager: dependencies.getConnectionManager,
      getManagerGeneration: () => this.managerGeneration,
      getTargetStore: dependencies.getTargetStore,
      inFlight: this.inFlight,
      ownershipGenerations: this.ownershipGenerations,
      probeTunnel: dependencies.probeTunnel,
      targeting: this.targeting,
      checkServing: (environment) => this.checkServing(environment)
    })
    this.forwards.setCallbacks({
      onForwardClosed: (entry) => {
        for (const [environmentId, active] of this.active) {
          if (active.forwardId === entry.id) {
            this.active.delete(environmentId)
          }
        }
      }
    })
  }

  ensure(
    environment: KnownRuntimeEnvironment,
    resolveCurrent: () => KnownRuntimeEnvironment | null = () => environment
  ): Promise<void> {
    if (!getRuntimeSshAccess(environment)) {
      return Promise.resolve()
    }
    const pending = this.inFlight.get(environment.id)
    if (pending) {
      return pending
    }
    const operation = this.ensureManagedTunnel(environment, resolveCurrent).finally(() => {
      if (this.inFlight.get(environment.id) === operation) {
        this.inFlight.delete(environment.id)
      }
    })
    this.inFlight.set(environment.id, operation)
    return operation
  }

  async start(
    environmentId: string,
    target: SshTarget,
    connection: SshConnection,
    remotePort: number,
    checks: OrcadTunnelStartChecks = {}
  ): Promise<number> {
    if (!target.generation) {
      throw new Error('Managed Orca SSH target has no registration generation.')
    }
    const managerGeneration = this.managerGeneration
    const ownershipGeneration = (this.ownershipGenerations.get(environmentId) ?? 0) + 1
    const transportGeneration = connection.getTransportGeneration()
    const stillCurrent = (): boolean =>
      this.managerGeneration === managerGeneration &&
      this.ownershipGenerations.get(environmentId) === ownershipGeneration &&
      connection.getTransportGeneration() === transportGeneration
    await this.close(environmentId)
    if (!stillCurrent()) {
      throw new Error('Orca SSH tunnel setup was superseded.')
    }
    const forward = await forwardToVerifiedOrcad({
      targetId: target.id,
      connection,
      forwards: this.forwards,
      localPort: 0,
      label: 'Managed Orca server',
      remotePort,
      rereadRemotePort: checks.rereadRemotePort,
      verify: checks.verify,
      stillCurrent
    })
    if (!forward) {
      throw new Error('Orca SSH tunnel setup was superseded.')
    }
    this.active.set(environmentId, {
      connection,
      forwardId: forward.id,
      localPort: forward.localPort,
      remotePort: forward.remotePort,
      preferredPort: checks.preferredPort ?? remotePort,
      sshTargetGeneration: target.generation,
      targetId: target.id,
      transportGeneration
    })
    return forward.localPort
  }

  async close(environmentId: string): Promise<void> {
    this.ownershipGenerations.set(
      environmentId,
      (this.ownershipGenerations.get(environmentId) ?? 0) + 1
    )
    const active = this.active.get(environmentId)
    if (!active) {
      return
    }
    this.active.delete(environmentId)
    await this.forwards.removeForwardAndWait(active.forwardId)
  }

  dispose(): void {
    this.managerGeneration += 1
    this.active.clear()
    this.inFlight.clear()
    this.ownershipGenerations.clear()
    this.resumeRecovery.dispose()
    this.forwards.dispose()
  }

  /** The server behind the tunnel answers, or is started; a moved port rebuilds the forward. */
  async verifyServing(environment: KnownRuntimeEnvironment): Promise<OrcadManagedServing> {
    if (!this.active.has(environment.id)) {
      await this.ensure(environment)
    }
    const serving = await this.checkServing(environment)
    if (serving.rebind) {
      await this.ensure(environment)
    }
    return serving
  }

  /** Never rebuilds, so it is safe inside a build: a moved port only drops the forward. */
  checkServing(environment: KnownRuntimeEnvironment): Promise<OrcadTunnelServing> {
    return checkManagedTunnelServing({
      environment,
      active: this.active,
      getTarget: (id) => this.dependencies.getTargetStore()?.getTarget(id),
      forwards: this.forwards,
      ensureServing: this.dependencies.ensureServing
    })
  }

  recoverAfterHostResume(options: OrcadManagedTunnelResumeOptions): Promise<void> {
    return this.resumeRecovery.recover(options)
  }

  private async ensureManagedTunnel(
    environment: KnownRuntimeEnvironment,
    resolveCurrent: () => KnownRuntimeEnvironment | null,
    rebound = false
  ): Promise<void> {
    const deployment = getRuntimeSshAccess(environment)
    if (!deployment || environment.connectionDependency !== 'ssh-tunnel') {
      throw new Error('Managed orcad environment is missing its SSH tunnel dependency.')
    }
    const targetStore = this.dependencies.getTargetStore()
    const connectionManager = this.dependencies.getConnectionManager()
    if (!targetStore || !connectionManager) {
      throw new Error('SSH is unavailable on this client; the managed Orca server is unverifiable.')
    }
    const target = targetStore.getTarget(deployment.sshTargetId)
    if (!target || target.generation !== deployment.sshTargetGeneration) {
      throw new Error(
        'The SSH registration for this managed Orca server was removed or re-created.'
      )
    }
    if (getManagedOrcadFenceEnvironmentId(target) !== environment.id) {
      throw new Error('The SSH target is no longer owned by this managed Orca server.')
    }

    const managerGeneration = this.managerGeneration
    const ownershipGeneration = this.ownershipGenerations.get(environment.id) ?? 0
    const stillOwned = (): boolean => {
      const currentTarget = targetStore.getTarget(target.id)
      const currentEnvironment = resolveCurrent()
      const currentAccess = currentEnvironment ? getRuntimeSshAccess(currentEnvironment) : undefined
      return (
        this.managerGeneration === managerGeneration &&
        (this.ownershipGenerations.get(environment.id) ?? 0) === ownershipGeneration &&
        currentTarget?.generation === target.generation &&
        getManagedOrcadFenceEnvironmentId(currentTarget) === environment.id &&
        currentEnvironment?.id === environment.id &&
        currentEnvironment.runtimeId === environment.runtimeId &&
        (currentEnvironment.pairingRevision ?? currentEnvironment.createdAt) ===
          (environment.pairingRevision ?? environment.createdAt) &&
        currentEnvironment.connectionDependency === 'ssh-tunnel' &&
        currentAccess?.sshTargetId === deployment.sshTargetId &&
        currentAccess.sshTargetGeneration === deployment.sshTargetGeneration &&
        currentAccess.localPort === deployment.localPort &&
        currentAccess.remotePort === deployment.remotePort
      )
    }
    const connection = await connectionManager.connect(target)
    if (!stillOwned()) {
      return
    }
    const transportGeneration = connection.getTransportGeneration()
    const active = this.active.get(environment.id)
    if (
      active?.connection === connection &&
      active.transportGeneration === transportGeneration &&
      active.targetId === target.id &&
      active.sshTargetGeneration === target.generation &&
      active.localPort === deployment.localPort &&
      active.preferredPort === deployment.remotePort
    ) {
      return
    }
    const checks = await environmentForwardChecks(this.targeting, {
      environment,
      target,
      connection
    })
    if (active && stillOwned()) {
      await this.forwards.removeForwardAndWait(active.forwardId)
      if (this.active.get(environment.id) === active) {
        this.active.delete(environment.id)
      }
    }
    if (!stillOwned()) {
      return
    }
    const forward = await forwardToVerifiedOrcad({
      targetId: target.id,
      connection,
      forwards: this.forwards,
      localPort: deployment.localPort,
      label: `Managed Orca server: ${environment.name}`,
      ...checks,
      stillCurrent: () =>
        stillOwned() && connection.getTransportGeneration() === transportGeneration
    })
    if (!forward) {
      return
    }
    this.active.set(environment.id, {
      connection,
      forwardId: forward.id,
      localPort: forward.localPort,
      remotePort: forward.remotePort,
      preferredPort: deployment.remotePort,
      sshTargetGeneration: target.generation,
      targetId: target.id,
      transportGeneration
    })
    if ((await this.checkServing(environment)).rebind && !rebound) {
      await this.ensureManagedTunnel(environment, resolveCurrent, true)
    }
  }
}
