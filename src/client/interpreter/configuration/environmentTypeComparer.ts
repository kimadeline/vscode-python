// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { injectable, inject } from 'inversify';
import { getArchitectureDisplayName } from '../../common/platform/registry';
import { EnvironmentType, PythonEnvironment } from '../../pythonEnvironments/info';
import { PythonVersion } from '../../pythonEnvironments/info/pythonVersion';
import { IInterpreterHelper } from '../contracts';
import { IInterpreterComparer } from './types';

/*
 * Order:
 * - Local environments (i.e `.venv`);
 * - Global environments (pipenv, conda), with conda environments at a lower priority, and "base" being last;
 * - Globally-installed interpreters (`/usr/bin/python3`).
 */
enum EnvTypeHeuristic {
    Local = 1,
    Global = 2,
    GlobalInterpreters = 3,
}

@injectable()
export class EnvironmentTypeComparer implements IInterpreterComparer {
    private workspaceFolderPath: string;

    constructor(@inject(IInterpreterHelper) private readonly interpreterHelper: IInterpreterHelper) {
        this.workspaceFolderPath = this.interpreterHelper.getActiveWorkspaceUri(undefined)?.folderUri.fsPath ?? '';
    }

    /**
     * Compare 2 Python environments, sorting them by assumed usefulness.
     * Return 0 if both environments are equal, -1 if a should be closer to the beginning of the list, or 1 if a comes after b.
     *
     * The comparison guidelines are:
     * 1. Local environments first (i.e `.venv`);
     * 2. Global environments next (conda);
     * 3. Globally-installed interpreters (`/usr/bin/python3`).
     *
     * Always sort with newest version of Python first within each subgroup.
     */
    public compare(a: PythonEnvironment, b: PythonEnvironment): number {
        // Check environment type.
        const envTypeComparison = compareEnvironmentType(a, b, this.workspaceFolderPath);
        if (envTypeComparison !== 0) {
            return envTypeComparison;
        }

        // Check Python version.
        const versionComparison = comparePythonVersion(a.version, b.version);
        if (versionComparison !== 0) {
            return versionComparison;
        }

        // Prioritize non-Conda environments.
        if (isCondaEnvironment(a) && !isCondaEnvironment(b)) {
            return 1;
        }

        if (!isCondaEnvironment(a) && isCondaEnvironment(b)) {
            return -1;
        }

        // If we have the "base" Conda env, put it last in its Python version subgroup.
        if (isBaseCondaEnvironment(a)) {
            return 1;
        }

        // Check alphabetical order (same way as the InterpreterComparer class).
        const nameA = this.getSortName(a);
        const nameB = this.getSortName(b);
        if (nameA === nameB) {
            return 0;
        }

        return nameA > nameB ? 1 : -1;
    }

    private getSortName(info: PythonEnvironment): string {
        const sortNameParts: string[] = [];
        const envSuffixParts: string[] = [];

        // Sort order for interpreters is:
        // * Version
        // * Architecture
        // * Interpreter Type
        // * Environment name
        if (info.version) {
            sortNameParts.push(info.version.raw);
        }
        if (info.architecture) {
            sortNameParts.push(getArchitectureDisplayName(info.architecture));
        }
        if (info.companyDisplayName && info.companyDisplayName.length > 0) {
            sortNameParts.push(info.companyDisplayName.trim());
        } else {
            sortNameParts.push('Python');
        }

        if (info.envType) {
            const name = this.interpreterHelper.getInterpreterTypeDisplayName(info.envType);
            if (name) {
                envSuffixParts.push(name);
            }
        }
        if (info.envName && info.envName.length > 0) {
            envSuffixParts.push(info.envName);
        }

        const envSuffix = envSuffixParts.length === 0 ? '' : `(${envSuffixParts.join(': ')})`;
        return `${sortNameParts.join(' ')} ${envSuffix}`.trim();
    }
}

function isCondaEnvironment(environment: PythonEnvironment): boolean {
    return environment.envType === EnvironmentType.Conda;
}

function isBaseCondaEnvironment(environment: PythonEnvironment): boolean {
    return isCondaEnvironment(environment) && (environment.envName === 'base' || environment.envName === 'miniconda');
}

/**
 * Compare 2 Python versions in decending order, most recent one comes first.
 */
function comparePythonVersion(a: PythonVersion | undefined, b: PythonVersion | undefined): number {
    if (!a) {
        return 1;
    }

    if (!b) {
        return -1;
    }

    if (a.raw === b.raw) {
        return 0;
    }

    if (a.major === b.major) {
        if (a.minor === b.minor) {
            if (a.patch === b.patch) {
                return a.build.join(' ') > b.build.join(' ') ? -1 : 1;
            }
            return a.patch > b.patch ? -1 : 1;
        }
        return a.minor > b.minor ? -1 : 1;
    }

    return a.major > b.major ? -1 : 1;
}

/**
 * Compare 2 environment types, return 0 if they are the same, -1 if a comes before b, 1 otherwise.
 */
function compareEnvironmentType(a: PythonEnvironment, b: PythonEnvironment, workspacePath: string): number {
    const aHeuristic = getEnvTypeHeuristic(a, workspacePath);
    const bHeuristic = getEnvTypeHeuristic(b, workspacePath);

    return Math.sign(aHeuristic - bHeuristic);
}

/**
 * Returns a heuristic value depending on the environment type:
 * - 1: Local environments
 * - 2: Global environments
 * - 3: Global interpreters
 */
function getEnvTypeHeuristic(environment: PythonEnvironment, workspacePath: string): EnvTypeHeuristic {
    const { envType } = environment;

    switch (envType) {
        case EnvironmentType.Venv: {
            if (workspacePath.length > 0 && environment.path.startsWith(workspacePath)) {
                return EnvTypeHeuristic.Local;
            }
            return EnvTypeHeuristic.Global;
        }
        case EnvironmentType.Conda:
        case EnvironmentType.VirtualEnv:
        case EnvironmentType.VirtualEnvWrapper:
        case EnvironmentType.Pipenv:
        case EnvironmentType.Poetry:
            return EnvTypeHeuristic.Global;
        // The default case covers global environments.
        // For now this includes: pyenv, Windows Store and everything under "Global", "System" and "Unknown".
        default:
            return EnvTypeHeuristic.GlobalInterpreters;
    }
}