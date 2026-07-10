import type {
  AddCategoryCatalogEntryRequest,
  CategoryCatalogResponse,
  ComposeFinalPromptRequest,
  ComposeFinalPromptResponse,
  DeleteCategoryCatalogImageRequest,
  GeneratePatternImageRequest,
  GeneratePatternImageResponse,
  MaterialShapeAnalysisRequest,
  MaterialShapeAnalysisResponse,
  PrepareProposalPackageRequest,
  PrepareProposalRequest,
  ProposalAgentPrepareResponse,
  UploadCategoryCatalogImageRequest,
} from '../types/proposal';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:3101';
const AI_REQUEST_TIMEOUT_MS = 150000;
const IMAGE_GENERATION_REQUEST_TIMEOUT_MS = 660000;

type ApiErrorResponse = {
  error?: string;
  error_message?: string;
};

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s.`);
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

async function parseApiResponse<T>(response: Response, fallbackMessage: string): Promise<T> {
  const body = (await response.json().catch(() => ({
    error_message: fallbackMessage,
  }))) as T | ApiErrorResponse;

  if (!response.ok) {
    const errorBody = body as ApiErrorResponse;
    throw new Error(
      errorBody.error_message || errorBody.error || `${fallbackMessage}: ${response.status}`,
    );
  }

  return body as T;
}

export async function prepareProposal(
  request: PrepareProposalRequest,
): Promise<ProposalAgentPrepareResponse> {
  const response = await fetch(`${API_BASE_URL}/api/proposal-agent/prepare`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(request),
  });

  return parseApiResponse<ProposalAgentPrepareResponse>(
    response,
    `Lookup failed: ${response.status}`,
  );
}

export async function prepareProposalPackage(
  request: PrepareProposalPackageRequest,
): Promise<ProposalAgentPrepareResponse> {
  const response = await fetch(`${API_BASE_URL}/api/proposal-package/prepare`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(request),
  });

  return parseApiResponse<ProposalAgentPrepareResponse>(
    response,
    `Proposal package prepare failed: ${response.status}`,
  );
}

export async function getCategoryCatalog(): Promise<CategoryCatalogResponse> {
  const response = await fetch(`${API_BASE_URL}/api/category-catalog`);
  return parseApiResponse<CategoryCatalogResponse>(
    response,
    `Category catalog lookup failed: ${response.status}`,
  );
}

export async function addCategoryCatalogEntry(
  request: AddCategoryCatalogEntryRequest,
): Promise<CategoryCatalogResponse> {
  const response = await fetch(`${API_BASE_URL}/api/category-catalog/entries`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(request),
  });
  const body = await parseApiResponse<{ catalog: CategoryCatalogResponse }>(
    response,
    `Category catalog save failed: ${response.status}`,
  );

  return body.catalog;
}

export async function uploadCategoryCatalogImage(
  request: UploadCategoryCatalogImageRequest,
): Promise<CategoryCatalogResponse> {
  const response = await fetch(`${API_BASE_URL}/api/category-catalog/entries/image`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(request),
  });
  const body = await parseApiResponse<{ catalog: CategoryCatalogResponse }>(
    response,
    `Category image upload failed: ${response.status}`,
  );

  return body.catalog;
}

export async function deleteCategoryCatalogImage(
  request: DeleteCategoryCatalogImageRequest,
): Promise<CategoryCatalogResponse> {
  const response = await fetch(`${API_BASE_URL}/api/category-catalog/entries/image`, {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(request),
  });
  const body = await parseApiResponse<{ catalog: CategoryCatalogResponse }>(
    response,
    `Category image delete failed: ${response.status}`,
  );

  return body.catalog;
}

export async function generatePatternImage(
  request: GeneratePatternImageRequest,
): Promise<GeneratePatternImageResponse> {
  const response = await fetchWithTimeout(
    `${API_BASE_URL}/api/image-generation/generate`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    },
    IMAGE_GENERATION_REQUEST_TIMEOUT_MS,
  );
  const body = (await response.json().catch(() => ({
    error_message: `Image generation failed: ${response.status}`,
  }))) as GeneratePatternImageResponse | ApiErrorResponse;

  if (!response.ok) {
    const maybeGenerationResponse = body as GeneratePatternImageResponse;
    if (maybeGenerationResponse.source === 'ai_image_generator') {
      return maybeGenerationResponse;
    }

    const errorBody = body as ApiErrorResponse;
    throw new Error(
      errorBody.error_message || errorBody.error || `Image generation failed: ${response.status}`,
    );
  }

  return body as GeneratePatternImageResponse;
}

export async function composeFinalPrompt(
  request: ComposeFinalPromptRequest,
): Promise<ComposeFinalPromptResponse> {
  const response = await fetchWithTimeout(
    `${API_BASE_URL}/api/final-prompt/compose`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    },
    AI_REQUEST_TIMEOUT_MS,
  );
  const body = (await response.json().catch(() => ({
    error_message: `Final prompt composition failed: ${response.status}`,
  }))) as ComposeFinalPromptResponse | ApiErrorResponse;

  if (!response.ok) {
    const maybePromptResponse = body as ComposeFinalPromptResponse;
    if (maybePromptResponse.source === 'ai_final_prompt_composer') {
      return maybePromptResponse;
    }

    const errorBody = body as ApiErrorResponse;
    throw new Error(
      errorBody.error_message ||
        errorBody.error ||
        `Final prompt composition failed: ${response.status}`,
    );
  }

  return body as ComposeFinalPromptResponse;
}

export async function analyzeMaterialShapeLevels(
  request: MaterialShapeAnalysisRequest,
): Promise<MaterialShapeAnalysisResponse> {
  const response = await fetchWithTimeout(
    `${API_BASE_URL}/api/material-shape/analyze`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    },
    AI_REQUEST_TIMEOUT_MS,
  );
  const body = (await response.json().catch(() => ({
    error_message: `Material shape analysis failed: ${response.status}`,
  }))) as MaterialShapeAnalysisResponse | ApiErrorResponse;

  if (!response.ok) {
    const maybeAnalysisResponse = body as MaterialShapeAnalysisResponse;
    if (maybeAnalysisResponse.source === 'ai_material_shape_analyzer') {
      return maybeAnalysisResponse;
    }

    const errorBody = body as ApiErrorResponse;
    throw new Error(
      errorBody.error_message ||
        errorBody.error ||
        `Material shape analysis failed: ${response.status}`,
    );
  }

  return body as MaterialShapeAnalysisResponse;
}
