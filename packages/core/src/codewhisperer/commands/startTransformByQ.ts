/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode'
import * as fs from 'fs' // eslint-disable-line no-restricted-imports
import os from 'os'
import path from 'path'
import { getLogger } from '../../shared/logger/logger'
import * as CodeWhispererConstants from '../models/constants'
import * as localizedText from '../../shared/localizedText'
import {
    transformByQState,
    StepProgress,
    JDKVersion,
    jobPlanProgress,
    FolderInfo,
    ZipManifest,
    TransformationType,
    TransformationCandidateProject,
    RegionProfile,
} from '../models/model'
import {
    createZipManifest,
    downloadAndExtractResultArchive,
    downloadHilResultArchive,
    findDownloadArtifactStep,
    getArtifactsFromProgressUpdate,
    getTransformationSteps,
    pollTransformationJob,
    resumeTransformationJob,
    startJob,
    stopJob,
    throwIfCancelled,
    updateJobHistory,
    uploadPayload,
    zipCode,
} from '../service/transformByQ/transformApiHandler'
import {
    getJavaProjects,
    getOpenProjects,
    validateOpenProjects,
} from '../service/transformByQ/transformProjectValidationHandler'
import {
    prepareProjectDependencies,
    runMavenDependencyUpdateCommands,
} from '../service/transformByQ/transformMavenHandler'
import { telemetry } from '../../shared/telemetry/telemetry'
import { CodeTransformTelemetryState } from '../../amazonqGumby/telemetry/codeTransformTelemetryState'
import { calculateTotalLatency } from '../../amazonqGumby/telemetry/codeTransformTelemetry'
import { MetadataResult } from '../../shared/telemetry/telemetryClient'
import { submitFeedback } from '../../feedback/vue/submitFeedback'
import { placeholder } from '../../shared/vscode/commands2'
import {
    AlternateDependencyVersionsNotFoundError,
    JobStartError,
    ModuleUploadError,
    PollJobError,
    TransformationPreBuildError,
} from '../../amazonqGumby/errors'
import { ChatSessionManager } from '../../amazonqGumby/chat/storages/chatSession'
import {
    getCodeIssueSnippetFromPom,
    getDependenciesFolderInfo,
    getJsonValuesFromManifestFile,
    highlightPomIssueInProject,
    parseVersionsListFromPomFile,
    writeAndShowBuildLogs,
} from '../service/transformByQ/transformFileHandler'
import { sleep } from '../../shared/utilities/timeoutUtils'
import DependencyVersions from '../../amazonqGumby/models/dependencies'
import { dependencyNoAvailableVersions } from '../../amazonqGumby/models/constants'
import { HumanInTheLoopManager } from '../service/transformByQ/humanInTheLoopManager'
import { setContext } from '../../shared/vscode/setContext'
import globals from '../../shared/extensionGlobals'
import { convertDateToTimestamp } from '../../shared/datetime'
import { findStringInDirectory } from '../../shared/utilities/workspaceUtils'
import { makeTemporaryToolkitFolder } from '../../shared/filesystemUtilities'
import { AuthUtil } from '../util/authUtil'

export function getFeedbackCommentData() {
    const jobId = transformByQState.getJobId()
    const s = `Q CodeTransformation jobId: ${jobId ? jobId : 'none'}`
    return s
}

export async function processLanguageUpgradeTransformFormInput(
    pathToProject: string,
    fromJDKVersion: JDKVersion,
    toJDKVersion: JDKVersion
) {
    transformByQState.setTransformationType(TransformationType.LANGUAGE_UPGRADE)
    transformByQState.setProjectName(path.basename(pathToProject))
    transformByQState.setProjectPath(pathToProject)
    transformByQState.setSourceJDKVersion(fromJDKVersion)
    transformByQState.setTargetJDKVersion(toJDKVersion)
}

export async function processSQLConversionTransformFormInput(pathToProject: string, schema: string) {
    transformByQState.setTransformationType(TransformationType.SQL_CONVERSION)
    transformByQState.setProjectName(path.basename(pathToProject))
    transformByQState.setProjectPath(pathToProject)
    transformByQState.setSchema(schema)
    // use dummy values of JDK8 & JDK17 so that startJob API can be called
    transformByQState.setSourceJDKVersion(JDKVersion.JDK8)
    transformByQState.setTargetJDKVersion(JDKVersion.JDK17)
}

export async function compileProject() {
    try {
        const dependenciesFolder: FolderInfo = await getDependenciesFolderInfo()
        transformByQState.setDependencyFolderInfo(dependenciesFolder)
        const projectPath = transformByQState.getProjectPath()
        await prepareProjectDependencies(dependenciesFolder.path, projectPath)
    } catch (err) {
        // open build-logs.txt file to show user error logs
        await writeAndShowBuildLogs(true)
        throw err
    }
}

export function startInterval() {
    const intervalId = setInterval(() => {
        void vscode.commands.executeCommand(
            'aws.amazonq.showPlanProgressInHub',
            CodeTransformTelemetryState.instance.getStartTime()
        )
        updateJobHistory()
    }, CodeWhispererConstants.transformationJobPollingIntervalSeconds * 1000)
    transformByQState.setIntervalId(intervalId)
}

export async function startTransformByQ() {
    // Set the default state variables for our store and the UI
    const transformStartTime = globals.clock.Date.now()
    await setTransformationToRunningState()

    try {
        const profile = AuthUtil.instance.regionProfileManager.activeRegionProfile
        // Set webview UI to poll for progress
        startInterval()

        // step 1: CreateUploadUrl and upload code
        const uploadId = await preTransformationUploadCode()

        // step 2: StartJob and store the returned jobId in TransformByQState
        const jobId = await startTransformationJob(uploadId, transformStartTime, profile)

        // step 3 (intermediate step): show transformation-plan.md file
        await pollTransformationStatusUntilPlanReady(jobId)

        // step 4: poll until artifacts are ready to download
        await humanInTheLoopRetryLogic(jobId, profile)
    } catch (error: any) {
        await transformationJobErrorHandler(error)
    } finally {
        await postTransformationJob()
        await cleanupTransformationJob()
    }
}

/**
 *  The whileLoop condition WaitingUserInput is set inside pollTransformationStatusUntilComplete
 *  when we see a `PAUSED` state. If this is the case once completeHumanInTheLoopWork the
 *  WaitingUserInput should still be set until pollTransformationStatusUntilComplete is called again.
 *  We only don't want to continue calling pollTransformationStatusUntilComplete if there is no HIL
 *  state ever engaged or we have reached our max amount of HIL retries.
 */
export async function humanInTheLoopRetryLogic(jobId: string, profile: RegionProfile | undefined) {
    let status = ''
    try {
        status = await pollTransformationStatusUntilComplete(jobId, profile)
        if (status === 'PAUSED') {
            const hilStatusFailure = await initiateHumanInTheLoopPrompt(jobId)
            if (hilStatusFailure) {
                // resume polling
                void humanInTheLoopRetryLogic(jobId, profile)
            }
        } else {
            await finalizeTransformByQ(status)
        }
    } catch (error) {
        status = 'FAILED'
        await finalizeTransformByQ(status)
        throw error
    }
}

export async function finalizeTransformByQ(status: string) {
    try {
        // Set the result state variables for our store and the UI
        await finalizeTransformationJob(status)
    } catch (error: any) {
        await transformationJobErrorHandler(error)
    }
}

export async function preTransformationUploadCode() {
    await vscode.commands.executeCommand('aws.amazonq.transformationHub.focus')

    void vscode.window.showInformationMessage(CodeWhispererConstants.jobStartedNotification, {
        title: localizedText.ok,
    })

    let uploadId = ''
    throwIfCancelled()
    try {
        await telemetry.codeTransform_uploadProject.run(async () => {
            telemetry.record({ codeTransformSessionId: CodeTransformTelemetryState.instance.getSessionId() })

            const transformZipManifest = new ZipManifest()
            // if the user chose to skip unit tests, add the custom build command here
            transformZipManifest.customBuildCommand = transformByQState.getCustomBuildCommand()
            const zipCodeResult = await zipCode({
                // dependenciesFolder will be undefined for SQL conversions since we don't compileProject
                dependenciesFolder: transformByQState.getDependencyFolderInfo(),
                projectPath: transformByQState.getProjectPath(),
                zipManifest: transformZipManifest,
            })

            const payloadFilePath = zipCodeResult.tempFilePath
            const zipSize = zipCodeResult.fileSize

            telemetry.record({
                codeTransformTotalByteSize: zipSize,
            })

            transformByQState.setPayloadFilePath(payloadFilePath)
            uploadId = await uploadPayload(payloadFilePath, AuthUtil.instance.regionProfileManager.activeRegionProfile)
            telemetry.record({ codeTransformJobId: uploadId }) // uploadId is re-used as jobId
        })
    } catch (err) {
        const errorMessage = (err as Error).message
        transformByQState.setJobFailureErrorNotification(
            `${CodeWhispererConstants.failedToUploadProjectNotification} ${errorMessage}`
        )
        transformByQState.setJobFailureErrorChatMessage(
            `${CodeWhispererConstants.failedToUploadProjectChatMessage} ${errorMessage}`
        )

        transformByQState.getChatControllers()?.errorThrown.fire({
            error: new ModuleUploadError(),
            tabID: ChatSessionManager.Instance.getSession().tabID,
        })
        getLogger().error(errorMessage)
        throw err
    }

    throwIfCancelled()
    await sleep(2000) // sleep before starting job to prevent ThrottlingException

    return uploadId
}

export async function initiateHumanInTheLoopPrompt(jobId: string) {
    try {
        const profile = AuthUtil.instance.regionProfileManager.activeRegionProfile
        const humanInTheLoopManager = HumanInTheLoopManager.instance
        // 1) We need to call GetTransformationPlan to get artifactId
        const transformationSteps = await getTransformationSteps(jobId, profile)
        const { transformationStep, progressUpdate } = findDownloadArtifactStep(transformationSteps)

        if (!transformationStep || !progressUpdate) {
            throw new Error('Transformation step or progress update is undefined')
        }

        const { artifactId, artifactType } = getArtifactsFromProgressUpdate(progressUpdate)

        // Early exit safeguard incase artifactId or artifactType are undefined
        if (!artifactId || !artifactType) {
            throw new Error('artifactId or artifactType is undefined')
        }

        // 2) We need to call DownloadResultArchive to get the manifest and pom.xml
        const { pomFileVirtualFileReference, manifestFileVirtualFileReference } = await downloadHilResultArchive(
            jobId,
            artifactId,
            humanInTheLoopManager.getTmpDownloadsDir()
        )
        humanInTheLoopManager.setPomFileVirtualFileReference(pomFileVirtualFileReference)
        const manifestFileValues = await getJsonValuesFromManifestFile(manifestFileVirtualFileReference)
        humanInTheLoopManager.setManifestFileValues(manifestFileValues)

        // 3) We need to replace version in pom.xml
        const newPomFileVirtualFileReference = await humanInTheLoopManager.createPomFileCopy(
            humanInTheLoopManager.getTmpDependencyListDir(),
            pomFileVirtualFileReference
        )
        humanInTheLoopManager.setNewPomFileVirtualFileReference(newPomFileVirtualFileReference)
        await humanInTheLoopManager.replacePomFileVersion(
            newPomFileVirtualFileReference,
            manifestFileValues.sourcePomVersion
        )

        const codeSnippet = await getCodeIssueSnippetFromPom(newPomFileVirtualFileReference)
        // Let the user know we've entered the loop in the chat
        transformByQState.getChatControllers()?.humanInTheLoopStartIntervention.fire({
            tabID: ChatSessionManager.Instance.getSession().tabID,
            codeSnippet,
        })

        // 4) We need to run maven commands on that pom.xml to get available versions
        const compileFolderInfo = humanInTheLoopManager.getCompileDependencyListFolderInfo()
        runMavenDependencyUpdateCommands(compileFolderInfo)
        const xmlString = await humanInTheLoopManager.getDependencyListXmlOutput()
        const { latestVersion, majorVersions, minorVersions, status } = await parseVersionsListFromPomFile(xmlString)

        if (status === dependencyNoAvailableVersions) {
            // let user know and early exit for human in the loop happened because no upgrade versions available
            const error = new AlternateDependencyVersionsNotFoundError()

            transformByQState.getChatControllers()?.errorThrown.fire({
                error,
                tabID: ChatSessionManager.Instance.getSession().tabID,
            })

            throw error
        }

        const dependencies = new DependencyVersions(
            latestVersion,
            majorVersions,
            minorVersions,
            manifestFileValues.sourcePomVersion
        )

        // 5) We need to wait for user input
        // This is asynchronous, so we have to wait to be called to complete this loop
        transformByQState.getChatControllers()?.humanInTheLoopPromptUserForDependency.fire({
            tabID: ChatSessionManager.Instance.getSession().tabID,
            dependencies,
        })
    } catch (err: any) {
        try {
            // Regardless of the error,
            // Continue transformation flow
            await terminateHILEarly(jobId)
        } finally {
            transformByQState.getChatControllers()?.errorThrown.fire({
                error: err,
                tabID: ChatSessionManager.Instance.getSession().tabID,
            })
        }
        CodeTransformTelemetryState.instance.setCodeTransformMetaDataField({
            errorMessage: err.message,
        })
        await HumanInTheLoopManager.instance.cleanUpArtifacts()
        return true
    } finally {
        await sleep(1000)
        telemetry.codeTransform_humanInTheLoop.emit({
            codeTransformSessionId: CodeTransformTelemetryState.instance.getSessionId(),
            codeTransformJobId: jobId,
            codeTransformMetadata: CodeTransformTelemetryState.instance.getCodeTransformMetaDataString(),
            result: MetadataResult.Fail,
            // TODO: make a generic reason field for telemetry logging so we don't log sensitive PII data
            reason: 'Runtime error occurred',
        })
    }
    return false
}

export async function openHilPomFile() {
    const humanInTheLoopManager = HumanInTheLoopManager.instance
    await highlightPomIssueInProject(
        humanInTheLoopManager.getNewPomFileVirtualFileReference(),
        HumanInTheLoopManager.instance.diagnosticCollection,
        humanInTheLoopManager.getManifestFileValues().sourcePomVersion
    )
}

export async function terminateHILEarly(jobID: string) {
    // Call resume with "REJECTED" state which will put our service
    // back into the normal flow and will not trigger HIL again for this step
    await resumeTransformationJob(jobID, 'REJECTED')
}

export async function finishHumanInTheLoop(selectedDependency?: string) {
    let successfulFeedbackLoop = true
    const jobId = transformByQState.getJobId()
    let hilResult: MetadataResult = MetadataResult.Pass
    const profile = AuthUtil.instance.regionProfileManager.activeRegionProfile
    try {
        if (!selectedDependency) {
            throw new Error('No dependency selected')
        }
        const humanInTheLoopManager = HumanInTheLoopManager.instance
        const manifestFileValues = humanInTheLoopManager.getManifestFileValues()
        const getUserInputValue = selectedDependency

        CodeTransformTelemetryState.instance.setCodeTransformMetaDataField({
            dependencyVersionSelected: selectedDependency,
        })
        // 6) We need to add user input to that pom.xml,
        // original pom.xml is intact somewhere, and run maven compile
        const userInputPomFileVirtualFileReference = await humanInTheLoopManager.createPomFileCopy(
            humanInTheLoopManager.getUserDependencyUpdateDir(),
            humanInTheLoopManager.getPomFileVirtualFileReference()
        )
        await humanInTheLoopManager.replacePomFileVersion(userInputPomFileVirtualFileReference, getUserInputValue)

        // 7) We need to take that output of maven and use CreateUploadUrl
        const uploadFolderInfo = humanInTheLoopManager.getUploadFolderInfo()
        await prepareProjectDependencies(uploadFolderInfo.path, uploadFolderInfo.path)
        // zipCode side effects deletes the uploadFolderInfo right away
        const uploadResult = await zipCode({
            dependenciesFolder: uploadFolderInfo,
            zipManifest: createZipManifest({
                hilZipParams: {
                    pomGroupId: manifestFileValues.pomGroupId,
                    pomArtifactId: manifestFileValues.pomArtifactId,
                    targetPomVersion: getUserInputValue,
                },
            }),
        })

        await uploadPayload(uploadResult.tempFilePath, profile, {
            transformationUploadContext: {
                jobId,
                uploadArtifactType: 'Dependencies',
            },
        })

        // inform user in chat
        transformByQState.getChatControllers()?.humanInTheLoopSelectionUploaded.fire({
            tabID: ChatSessionManager.Instance.getSession().tabID,
        })

        // 8) Once code has been uploaded we will restart the job
        await resumeTransformationJob(jobId, 'COMPLETED')

        void humanInTheLoopRetryLogic(jobId, profile)
    } catch (err: any) {
        successfulFeedbackLoop = false
        CodeTransformTelemetryState.instance.setCodeTransformMetaDataField({
            errorMessage: err.message,
        })
        hilResult = MetadataResult.Fail

        // If anything went wrong in HIL state, we should restart the job
        // with the rejected state
        await terminateHILEarly(jobId)
        void humanInTheLoopRetryLogic(jobId, profile)
    } finally {
        telemetry.codeTransform_humanInTheLoop.emit({
            codeTransformSessionId: CodeTransformTelemetryState.instance.getSessionId(),
            codeTransformJobId: jobId,
            codeTransformMetadata: CodeTransformTelemetryState.instance.getCodeTransformMetaDataString(),
            result: hilResult,
            reason: hilResult === MetadataResult.Fail ? 'Runtime error occurred' : undefined,
        })
        await HumanInTheLoopManager.instance.cleanUpArtifacts()
    }

    return successfulFeedbackLoop
}

export async function startTransformationJob(
    uploadId: string,
    transformStartTime: number,
    profile: RegionProfile | undefined
) {
    let jobId = ''
    try {
        await telemetry.codeTransform_jobStart.run(async () => {
            telemetry.record({ codeTransformSessionId: CodeTransformTelemetryState.instance.getSessionId() })

            jobId = await startJob(uploadId, profile)
            getLogger().info(`CodeTransformation: jobId: ${jobId}`)

            telemetry.record({
                codeTransformJobId: jobId,
                codeTransformRunTimeLatency: calculateTotalLatency(transformStartTime),
            })
        })
    } catch (error) {
        getLogger().error(`CodeTransformation: ${CodeWhispererConstants.failedToStartJobNotification}`, error)
        const errorMessage = (error as Error).message.toLowerCase()
        if (errorMessage.includes('too many active running jobs')) {
            transformByQState.setJobFailureErrorNotification(CodeWhispererConstants.tooManyJobsNotification)
            transformByQState.setJobFailureErrorChatMessage(CodeWhispererConstants.tooManyJobsChatMessage)
        } else if (errorMessage.includes('lines of code limit breached')) {
            transformByQState.setJobFailureErrorNotification(
                CodeWhispererConstants.linesOfCodeLimitBreachedNotification
            )
            transformByQState.setJobFailureErrorChatMessage(CodeWhispererConstants.linesOfCodeLimitBreachedChatMessage)
        } else {
            transformByQState.setJobFailureErrorNotification(
                `${CodeWhispererConstants.failedToStartJobNotification} ${errorMessage}`
            )
            transformByQState.setJobFailureErrorChatMessage(
                `${CodeWhispererConstants.failedToStartJobChatMessage} ${errorMessage}`
            )
        }
        throw new JobStartError()
    }

    await sleep(5000) // sleep before polling job status to prevent ThrottlingException
    throwIfCancelled()

    return jobId
}

export async function pollTransformationStatusUntilPlanReady(jobId: string, profile?: RegionProfile) {
    try {
        await pollTransformationJob(jobId, CodeWhispererConstants.validStatesForPlanGenerated, profile)
    } catch (error) {
        getLogger().error(`CodeTransformation: ${CodeWhispererConstants.failedToCompleteJobNotification}`, error)

        if (!transformByQState.getJobFailureErrorNotification()) {
            transformByQState.setJobFailureErrorNotification(CodeWhispererConstants.failedToCompleteJobNotification)
        }
        if (!transformByQState.getJobFailureErrorChatMessage()) {
            transformByQState.setJobFailureErrorChatMessage(CodeWhispererConstants.failedToCompleteJobChatMessage)
        }

        // try to download pre-build error logs if available
        let pathToLog = ''
        try {
            const tempToolkitFolder = await makeTemporaryToolkitFolder()
            const tempBuildLogsDir = path.join(tempToolkitFolder, 'q-transformation-build-logs')
            await downloadAndExtractResultArchive(jobId, tempBuildLogsDir)
            pathToLog = path.join(tempBuildLogsDir, 'buildCommandOutput.log')
            transformByQState.setPreBuildLogFilePath(pathToLog)
        } catch (e) {
            transformByQState.setPreBuildLogFilePath('')
            getLogger().error(
                'CodeTransformation: failed to download any possible build error logs: ' + (e as Error).message
            )
            throw e
        }

        if (fs.existsSync(pathToLog) && !transformByQState.isCancelled()) {
            throw new TransformationPreBuildError()
        } else {
            // not strictly needed to reset path here and above; doing it just to represent unavailable logs
            transformByQState.setPreBuildLogFilePath('')
            throw new PollJobError()
        }
    }
    if (transformByQState.getTransformationType() === TransformationType.SQL_CONVERSION) {
        // for now, no plan shown with SQL conversions. later, we may add one
        return
    }
    jobPlanProgress['generatePlan'] = StepProgress.Succeeded
    throwIfCancelled()
}

export async function pollTransformationStatusUntilComplete(jobId: string, profile: RegionProfile | undefined) {
    let status = ''
    try {
        status = await pollTransformationJob(jobId, CodeWhispererConstants.validStatesForCheckingDownloadUrl, profile)
    } catch (error) {
        getLogger().error(`CodeTransformation: ${CodeWhispererConstants.failedToCompleteJobNotification}`, error)
        if (!transformByQState.getJobFailureErrorNotification()) {
            transformByQState.setJobFailureErrorNotification(CodeWhispererConstants.failedToCompleteJobNotification)
        }
        if (!transformByQState.getJobFailureErrorChatMessage()) {
            transformByQState.setJobFailureErrorChatMessage(CodeWhispererConstants.failedToCompleteJobChatMessage)
        }
        throw new PollJobError()
    }

    return status
}

export async function finalizeTransformationJob(status: string) {
    if (!(status === 'COMPLETED' || status === 'PARTIALLY_COMPLETED')) {
        getLogger().error(`CodeTransformation: ${CodeWhispererConstants.failedToCompleteJobNotification}`)
        jobPlanProgress['transformCode'] = StepProgress.Failed
        if (!transformByQState.getJobFailureErrorNotification()) {
            transformByQState.setJobFailureErrorNotification(CodeWhispererConstants.failedToCompleteJobNotification)
        }
        if (!transformByQState.getJobFailureErrorChatMessage()) {
            transformByQState.setJobFailureErrorChatMessage(CodeWhispererConstants.failedToCompleteJobChatMessage)
        }
        throw new Error('Job was not successful nor partially successful')
    }
    transformByQState.setToSucceeded()
    if (status === 'PARTIALLY_COMPLETED') {
        transformByQState.setToPartiallySucceeded()
    }
    await vscode.commands.executeCommand('aws.amazonq.transformationHub.reviewChanges.reveal')
    jobPlanProgress['transformCode'] = StepProgress.Succeeded
}

export async function getValidLanguageUpgradeCandidateProjects() {
    const openProjects = await getOpenProjects()
    const javaMavenProjects = await validateOpenProjects(openProjects)
    getLogger().info(`CodeTransformation: found ${javaMavenProjects.length} projects eligible for language upgrade`)
    return javaMavenProjects
}

export async function getValidSQLConversionCandidateProjects() {
    const embeddedSQLProjects: TransformationCandidateProject[] = []
    await telemetry.codeTransform_validateProject.run(async () => {
        telemetry.record({
            codeTransformSessionId: CodeTransformTelemetryState.instance.getSessionId(),
        })
        const openProjects = await getOpenProjects()
        const javaProjects = await getJavaProjects(openProjects)
        let resultLog = ''
        for (const project of javaProjects) {
            // as long as at least one of these strings is found, project contains embedded SQL statements
            const searchStrings = ['oracle.jdbc.', 'jdbc:oracle:', 'jdbc:odbc:']
            for (const str of searchStrings) {
                const spawnResult = await findStringInDirectory(str, project.path)
                // just for telemetry purposes
                if (spawnResult.error || spawnResult.stderr) {
                    resultLog += `search error: ${JSON.stringify(spawnResult)}--`
                } else {
                    resultLog += `search complete (exit code: ${spawnResult.exitCode})--`
                }
                getLogger().info(`CodeTransformation: searching for ${str} in ${project.path}, result = ${resultLog}`)
                if (spawnResult.exitCode === 0) {
                    embeddedSQLProjects.push(project)
                    break
                }
            }
        }
        getLogger().info(
            `CodeTransformation: found ${embeddedSQLProjects.length} projects with embedded SQL statements`
        )
        telemetry.record({
            codeTransformMetadata: resultLog,
        })
    })
    return embeddedSQLProjects
}

export async function setTransformationToRunningState() {
    await setContextVariables()
    await vscode.commands.executeCommand('aws.amazonq.transformationHub.reviewChanges.reset')
    transformByQState.setToRunning()
    jobPlanProgress['uploadCode'] = StepProgress.Pending
    jobPlanProgress['buildCode'] = StepProgress.Pending
    jobPlanProgress['generatePlan'] = StepProgress.Pending
    jobPlanProgress['transformCode'] = StepProgress.Pending
    transformByQState.resetPlanSteps()
    transformByQState.resetSessionJobHistory()
    transformByQState.setJobId('') // so that details for last job are not overwritten when running one job after another
    transformByQState.setPolledJobStatus('') // so that previous job's status does not display at very beginning of this job
    transformByQState.setHasSeenTransforming(false)

    CodeTransformTelemetryState.instance.setStartTime()
    transformByQState.setStartTime(
        convertDateToTimestamp(new Date(CodeTransformTelemetryState.instance.getStartTime()))
    )

    await vscode.commands.executeCommand('workbench.view.extension.aws-codewhisperer-transformation-hub')
}

export async function postTransformationJob() {
    updateJobHistory()
    if (jobPlanProgress['uploadCode'] !== StepProgress.Succeeded) {
        jobPlanProgress['uploadCode'] = StepProgress.Failed
    }
    if (jobPlanProgress['buildCode'] !== StepProgress.Succeeded) {
        jobPlanProgress['buildCode'] = StepProgress.Failed
    }
    if (jobPlanProgress['generatePlan'] !== StepProgress.Succeeded) {
        jobPlanProgress['generatePlan'] = StepProgress.Failed
    }
    if (jobPlanProgress['transformCode'] !== StepProgress.Succeeded) {
        jobPlanProgress['transformCode'] = StepProgress.Failed
    }

    let chatMessage = transformByQState.getJobFailureErrorChatMessage()
    if (transformByQState.isSucceeded()) {
        chatMessage = CodeWhispererConstants.jobCompletedChatMessage
    } else if (transformByQState.isPartiallySucceeded()) {
        chatMessage = CodeWhispererConstants.jobPartiallyCompletedChatMessage
    }

    if (transformByQState.getSourceJDKVersion() !== transformByQState.getTargetJDKVersion()) {
        chatMessage += CodeWhispererConstants.upgradeLibrariesMessage
    }

    transformByQState.getChatControllers()?.transformationFinished.fire({
        message: chatMessage,
        tabID: ChatSessionManager.Instance.getSession().tabID,
    })
    const durationInMs = calculateTotalLatency(CodeTransformTelemetryState.instance.getStartTime())
    const resultStatusMessage = transformByQState.getStatus()

    telemetry.codeTransform_totalRunTime.emit({
        codeTransformSessionId: CodeTransformTelemetryState.instance.getSessionId(),
        codeTransformJobId: transformByQState.getJobId(),
        codeTransformResultStatusMessage: resultStatusMessage,
        codeTransformRunTimeLatency: durationInMs,
        reason: transformByQState.getPolledJobStatus(),
        result:
            transformByQState.isSucceeded() || transformByQState.isPartiallySucceeded()
                ? MetadataResult.Pass
                : MetadataResult.Fail,
    })

    let notificationMessage = ''

    if (transformByQState.isSucceeded()) {
        notificationMessage = CodeWhispererConstants.jobCompletedNotification
        if (transformByQState.getSourceJDKVersion() !== transformByQState.getTargetJDKVersion()) {
            notificationMessage += CodeWhispererConstants.upgradeLibrariesMessage
        }
        void vscode.window.showInformationMessage(notificationMessage, {
            title: localizedText.ok,
        })
    } else if (transformByQState.isPartiallySucceeded()) {
        notificationMessage = CodeWhispererConstants.jobPartiallyCompletedNotification
        if (transformByQState.getSourceJDKVersion() !== transformByQState.getTargetJDKVersion()) {
            notificationMessage += CodeWhispererConstants.upgradeLibrariesMessage
        }
        void vscode.window
            .showInformationMessage(notificationMessage, CodeWhispererConstants.amazonQFeedbackText)
            .then((choice) => {
                if (choice === CodeWhispererConstants.amazonQFeedbackText) {
                    void submitFeedback(
                        placeholder,
                        CodeWhispererConstants.amazonQFeedbackKey,
                        getFeedbackCommentData()
                    )
                }
            })
    }

    if (transformByQState.getPayloadFilePath()) {
        // delete original upload ZIP at very end of transformation
        fs.rmSync(transformByQState.getPayloadFilePath(), { force: true })
    }
    // delete temporary build logs file
    const logFilePath = path.join(os.tmpdir(), 'build-logs.txt')
    if (fs.existsSync(logFilePath)) {
        fs.rmSync(logFilePath, { force: true })
    }

    // attempt download for user
    // TODO: refactor as explained here https://github.com/aws/aws-toolkit-vscode/pull/6519/files#r1946873107
    if (transformByQState.isSucceeded() || transformByQState.isPartiallySucceeded()) {
        await vscode.commands.executeCommand('aws.amazonq.transformationHub.reviewChanges.startReview')
    }
}

export async function transformationJobErrorHandler(error: any) {
    if (!transformByQState.isCancelled()) {
        // means some other error occurred; cancellation already handled by now with stopTransformByQ
        await stopJob(transformByQState.getJobId())
        transformByQState.setToFailed()
        transformByQState.setPolledJobStatus('FAILED')
        // jobFailureErrorNotification should always be defined here
        const displayedErrorMessage =
            transformByQState.getJobFailureErrorNotification() ?? CodeWhispererConstants.failedToCompleteJobNotification
        transformByQState.setJobFailureErrorChatMessage(
            transformByQState.getJobFailureErrorChatMessage() ?? CodeWhispererConstants.failedToCompleteJobChatMessage
        )
        void vscode.window
            .showErrorMessage(displayedErrorMessage, CodeWhispererConstants.amazonQFeedbackText)
            .then((choice) => {
                if (choice === CodeWhispererConstants.amazonQFeedbackText) {
                    void submitFeedback(
                        placeholder,
                        CodeWhispererConstants.amazonQFeedbackKey,
                        getFeedbackCommentData()
                    )
                }
            })
    } else {
        transformByQState.setToCancelled()
        transformByQState.setPolledJobStatus('CANCELLED')
    }
    getLogger().error(`CodeTransformation: ${error.message}`)

    transformByQState.getChatControllers()?.errorThrown.fire({
        error,
        tabID: ChatSessionManager.Instance.getSession().tabID,
    })
}

export async function cleanupTransformationJob() {
    clearInterval(transformByQState.getIntervalId())
    transformByQState.setJobDefaults()
    await setContext('gumby.isStopButtonAvailable', false)
    await vscode.commands.executeCommand(
        'aws.amazonq.showPlanProgressInHub',
        CodeTransformTelemetryState.instance.getStartTime()
    )
    CodeTransformTelemetryState.instance.resetCodeTransformMetaDataField()
}

export async function stopTransformByQ(jobId: string) {
    await telemetry.codeTransform_jobIsCancelledByUser.run(async () => {
        telemetry.record({
            codeTransformSessionId: CodeTransformTelemetryState.instance.getSessionId(),
            codeTransformJobId: jobId,
        })
        if (transformByQState.isRunning()) {
            getLogger().info('CodeTransformation: User requested to stop transformation. Stopping transformation.')
            transformByQState.setToCancelled()
            transformByQState.setPolledJobStatus('CANCELLED')
            await setContext('gumby.isStopButtonAvailable', false)
            try {
                await stopJob(jobId)
                void vscode.window
                    .showErrorMessage(
                        CodeWhispererConstants.jobCancelledNotification,
                        CodeWhispererConstants.amazonQFeedbackText
                    )
                    .then((choice) => {
                        if (choice === CodeWhispererConstants.amazonQFeedbackText) {
                            void submitFeedback(
                                placeholder,
                                CodeWhispererConstants.amazonQFeedbackKey,
                                getFeedbackCommentData()
                            )
                        }
                    })
            } catch (err) {
                void vscode.window
                    .showErrorMessage(
                        CodeWhispererConstants.errorStoppingJobNotification,
                        CodeWhispererConstants.amazonQFeedbackText
                    )
                    .then((choice) => {
                        if (choice === CodeWhispererConstants.amazonQFeedbackText) {
                            void submitFeedback(
                                placeholder,
                                CodeWhispererConstants.amazonQFeedbackKey,
                                getFeedbackCommentData()
                            )
                        }
                    })
                getLogger().error(`CodeTransformation: Error stopping transformation ${err}`)
            }
        }
    })
}

async function setContextVariables() {
    await setContext('gumby.wasQCodeTransformationUsed', true)
    await setContext('gumby.isStopButtonAvailable', true)
    await setContext('gumby.isPlanAvailable', false)
    await setContext('gumby.isSummaryAvailable', false)
}
