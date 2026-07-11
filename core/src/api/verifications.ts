import type { FastifyReply, FastifyRequest } from 'fastify';
import type {
  CreateVerificationRequest,
  CreateVerificationData,
  IApiResponse,
  ListVerificationsData,
  ListVerificationsQuery,
  VerificationTaskData,
  VerificationTaskParams,
} from '@ignite/api';
import { ProfileManager } from '../filesystem/ProfileManager.js';
import { VerificationQueue } from '../verifications/VerificationQueue.js';
import { BundleStore } from '../verifications/BundleStore.js';
import { resolveMergedExplorers } from './explorers.js';
import { ExplorerStore } from '../chains/ExplorerStore.js';
import { ChainRegistry } from '../chains/ChainRegistry.js';
import { VerifierProviderService } from '../chains/VerifierProviderService.js';
import { PluginExecutor } from '../plugins/containers/PluginExecutor.js';
import { PluginRegistryLoader } from '../assets/PluginRegistryLoader.js';
import { RepoService } from '../repos/RepoService.js';
import {
  getCompilerArtifactData,
  getCompilerVerificationBundle,
} from './plugins/compiler/index.js';
import { encodeAbiParameters, type AbiParameter } from 'viem';
import { toConstructorArgs } from '../deployments/resolver.js';
import { guessConstructorArgs as guess } from '../verifications/guessArgs.js';
import { createPublicClient, http, type Hex } from 'viem';
import { sendBadRequest, sendCaughtError } from './utils/errors.js';
import type { ErrorCode } from '../types/errors.js';
type ProfileSource = { getCurrentProfile(): string };
export interface VerificationHandlerDeps {
  queue: Pick<
    VerificationQueue,
    'store' | 'retry' | 'cancel' | 'enqueueManual'
  >;
  getProfileManager: () => Promise<ProfileSource>;
  bundleStore: BundleStore;
  explorers: Parameters<typeof resolveMergedExplorers>[0];
  compiler: Parameters<typeof getCompilerArtifactData>[0];
}
export function createVerificationHandlers(
  deps?: Partial<VerificationHandlerDeps>
) {
  const d: VerificationHandlerDeps = {
    queue: deps?.queue ?? VerificationQueue.getInstance(),
    getProfileManager:
      deps?.getProfileManager ?? (() => ProfileManager.getInstance()),
    bundleStore: deps?.bundleStore ?? new BundleStore(),
    explorers: deps?.explorers ?? {
      registry: new ChainRegistry(),
      store: new ExplorerStore(),
      providers: VerifierProviderService.getInstance(),
    },
    compiler: deps?.compiler ?? {
      executor: PluginExecutor.getInstance(),
      registryLoader: PluginRegistryLoader.getInstance(),
      repos: RepoService.getInstance(),
    },
  };
  const profile = async () => (await d.getProfileManager()).getCurrentProfile();
  const fail = (reply: FastifyReply, error: unknown) =>
    sendCaughtError(
      reply,
      error,
      'VERIFICATION_ERROR' as ErrorCode,
      'Verification request failed'
    );
  return {
    listVerifications: async (
      request: FastifyRequest<{ Querystring: ListVerificationsQuery }>,
      reply: FastifyReply
    ): Promise<IApiResponse<ListVerificationsData>> => {
      try {
        return reply.status(200).send({
          data: {
            tasks: await d.queue.store.list(await profile(), request.query),
          },
        });
      } catch (error) {
        return fail(reply, error);
      }
    },
    createVerification: async (
      request: FastifyRequest<{ Body: CreateVerificationRequest }>,
      reply: FastifyReply
    ): Promise<IApiResponse<CreateVerificationData>> => {
      try {
        const profileId = await profile();
        const { contract } = request.body;
        const [artifact, bundleData] = await Promise.all([
          getCompilerArtifactData(d.compiler, {
            pluginId: contract.frameworkId,
            pathOrUrl: contract.repoPathOrUrl,
            artifactPath: contract.artifactPath,
            profileId,
          }),
          getCompilerVerificationBundle(d.compiler, {
            pluginId: contract.frameworkId,
            pathOrUrl: contract.repoPathOrUrl,
            artifactPath: contract.artifactPath,
            profileId,
          }),
        ]);
        // Same coherence gate as the launch freeze (spec dispositions 2/12):
        // getArtifactData and getVerificationBundle are separate container
        // invocations against a mutable workspace — the ABI used to encode
        // args and the bundle we publish must come from the SAME build.
        if (
          bundleData.creationCode.toLowerCase() !==
          artifact.creationCode.toLowerCase()
        ) {
          return sendBadRequest(
            reply,
            'BUNDLE_INCOHERENT' as ErrorCode,
            'The workspace changed during capture — recompile and retry'
          );
        }
        const bundleHash = await d.bundleStore.write(profileId, {
          ...bundleData,
          schemaVersion: 1,
          artifactHash: artifact.bytecodeHash,
          compilerSummary: {
            pluginId: contract.frameworkId,
            evmVersion: artifact.evmVersion,
            optimizer: artifact.optimizer,
            runs: artifact.optimizerRuns,
            viaIR: artifact.viaIR,
          },
        });
        const constructor = artifact.abi.find(
          (entry: { type?: string }) => entry.type === 'constructor'
        );
        const inputs = (constructor?.inputs ?? []) as AbiParameter[];
        const encodedConstructorArgs =
          request.body.args !== undefined
            ? encodeAbiParameters(
                inputs,
                toConstructorArgs(
                  inputs,
                  request.body.args
                ) as readonly unknown[]
              )
            : (request.body.encodedConstructorArgs ?? '0x');
        if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(encodedConstructorArgs))
          throw Object.assign(
            new Error('Constructor arguments must be even-length hex'),
            { code: 'INVALID_CONSTRUCTOR_ARGS' }
          );
        const all = await resolveMergedExplorers(
          d.explorers,
          request.body.chainId
        );
        const explorers = request.body.explorerEntryIds
          .map((id) => all.find((entry) => entry.id === id))
          .filter(
            (entry): entry is NonNullable<typeof entry> =>
              !!entry && !!entry.verifierPluginId
          )
          .map((entry) => ({
            entryId: entry.id,
            url: entry.url,
            apiUrl: entry.apiUrl,
            verifierPluginId: entry.verifierPluginId!,
            label: entry.label ?? entry.url,
            ...(entry.pageUrlTemplate
              ? { pageUrlTemplate: entry.pageUrlTemplate }
              : {}),
          }));
        if (explorers.length !== request.body.explorerEntryIds.length)
          throw Object.assign(
            new Error(
              'Every selected explorer must have a confirmed verifier mapping'
            ),
            { code: 'EXPLORER_MAPPING_UNCONFIRMED' }
          );
        const tasks = await d.queue.enqueueManual(profileId, request.body, {
          bundleHash,
          explorers,
          encodedConstructorArgs,
        });
        return reply.status(200).send({ data: { tasks } });
      } catch (error) {
        return fail(reply, error);
      }
    },
    guessConstructorArgs: async (
      request: FastifyRequest<{
        Body: {
          contract: CreateVerificationRequest['contract'];
          chainId: number;
          address: string;
        };
      }>,
      reply: FastifyReply
    ): Promise<any> => {
      try {
        const profileId = await profile();
        const c = request.body.contract;
        const [artifact, bundle] = await Promise.all([
          getCompilerArtifactData(d.compiler, {
            pluginId: c.frameworkId,
            pathOrUrl: c.repoPathOrUrl,
            artifactPath: c.artifactPath,
            profileId,
          }),
          getCompilerVerificationBundle(d.compiler, {
            pluginId: c.frameworkId,
            pathOrUrl: c.repoPathOrUrl,
            artifactPath: c.artifactPath,
            profileId,
          }),
        ]);
        const entries = await resolveMergedExplorers(
          d.explorers,
          request.body.chainId
        );
        const targets = entries
          .filter((entry) => !!entry.verifierPluginId)
          .map((entry) => ({
            entryId: entry.id,
            url: entry.url,
            apiUrl: entry.apiUrl,
            verifierPluginId: entry.verifierPluginId!,
            label: entry.label ?? entry.url,
            ...(entry.pageUrlTemplate
              ? { pageUrlTemplate: entry.pageUrlTemplate }
              : {}),
          }));
        const selected = await d.explorers.store.getSelection(
          request.body.chainId
        );
        const rpc = await new (
          await import('../chains/RpcStore.js')
        ).RpcStore().list(request.body.chainId);
        const endpoint = rpc.find((x) => x.preferred) ?? rpc[0];
        if (!endpoint)
          throw Object.assign(new Error('No verified RPC is configured'), {
            code: 'RPC_UNAVAILABLE',
          });
        const ctor = artifact.abi.find(
          (entry: { type?: string }) => entry.type === 'constructor'
        );
        const data = await guess({
          chainId: request.body.chainId,
          address: request.body.address,
          creationCode: bundle.creationCode,
          inputs: (ctor?.inputs ?? []) as AbiParameter[],
          explorers: targets,
          selectedIds: selected,
          getTransaction: async (hash) => {
            const tx = await createPublicClient({
              transport: http(endpoint.url),
            }).getTransaction({ hash: hash as Hex });
            return { to: tx.to, input: tx.input };
          },
        });
        return reply.status(200).send({ data });
      } catch (error) {
        return fail(reply, error);
      }
    },
    retryVerification: async (
      request: FastifyRequest<{ Params: VerificationTaskParams }>,
      reply: FastifyReply
    ): Promise<IApiResponse<VerificationTaskData>> => {
      try {
        return reply.status(200).send({
          data: {
            task: await d.queue.retry(await profile(), request.params.id),
          },
        });
      } catch (error) {
        return fail(reply, error);
      }
    },
    cancelVerification: async (
      request: FastifyRequest<{ Params: VerificationTaskParams }>,
      reply: FastifyReply
    ): Promise<IApiResponse<VerificationTaskData>> => {
      try {
        return reply.status(200).send({
          data: {
            task: await d.queue.cancel(await profile(), request.params.id),
          },
        });
      } catch (error) {
        return fail(reply, error);
      }
    },
  };
}
export const verificationHandlers = createVerificationHandlers();
