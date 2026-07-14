import type {
  PredictedEntryInfo,
  ProvisionalStepInfo,
  ValidationReport,
} from '@ignite/api';

export interface ReviewPredictedAddress {
  chainId: string;
  stepId: string;
  address: string;
  provisional: boolean;
}

/** Narrows the open validation details record at the UI boundary. */
export function reviewPredictedAddresses(
  report: ValidationReport | null | undefined
): ReviewPredictedAddress[] {
  return Object.entries(report?.chains ?? {}).flatMap(
    ([chainId, checklist]) => {
      const details = checklist.create2?.details;
      const predicted = details?.predicted;
      if (
        !predicted ||
        typeof predicted !== 'object' ||
        Array.isArray(predicted)
      )
        return [];
      const provisionalSteps = new Set(
        Array.isArray(details?.provisionalSteps)
          ? (details.provisionalSteps as ProvisionalStepInfo[])
              .filter((entry) => typeof entry?.stepId === 'string')
              .map((entry) => entry.stepId)
          : []
      );
      return Object.entries(predicted as Record<string, unknown>).flatMap(
        ([stepId, value]) => {
          if (!value || typeof value !== 'object' || Array.isArray(value))
            return [];
          const entry = value as PredictedEntryInfo;
          if (typeof entry.predictedAddress !== 'string') return [];
          return [
            {
              chainId,
              stepId,
              address: entry.predictedAddress,
              provisional:
                entry.provisional === true || provisionalSteps.has(stepId),
            },
          ];
        }
      );
    }
  );
}
