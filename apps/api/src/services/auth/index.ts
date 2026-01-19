import { AuthService } from './auth.service.js';
import { tokenService } from './token.service.js';
import { userRepository } from '../../infrastructure/database/repositories/user.repository.js';

// Create auth service with injected dependencies (Dependency Inversion)
export const authService = new AuthService(userRepository, tokenService);

export { AuthService } from './auth.service.js';
export { TokenService, tokenService } from './token.service.js';
export { getOAuthProvider, getAvailableProviders, isProviderAvailable } from './providers/oauth-provider.factory.js';
export { GoogleOAuthProvider, googleOAuthProvider } from './providers/google.provider.js';
