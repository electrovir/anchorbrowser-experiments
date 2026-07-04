import {createUpdatingSecrets, defineSecrets, SecretsJsonFileAdapter} from 'updating-secrets';
import {secretsJsonPath} from './file-paths.js';

const anchorBrowserSecrets = defineSecrets({
    apiKey: {
        description: 'API key used to authenticate with Anchor Browser.',
        whereToFind: 'Anchor Browser dashboard > API Access.',
    },
});

export async function createSecretsClient() {
    return await createUpdatingSecrets(anchorBrowserSecrets, [
        new SecretsJsonFileAdapter(secretsJsonPath, {
            generateValues() {
                return {};
            },
        }),
    ]);
}

export type SecretsClient = Awaited<ReturnType<typeof createSecretsClient>>;
