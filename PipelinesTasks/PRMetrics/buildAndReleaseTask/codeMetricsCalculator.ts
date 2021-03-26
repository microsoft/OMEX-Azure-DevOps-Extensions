// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { CommentThreadStatus, GitPullRequestCommentThread } from 'azure-devops-node-api/interfaces/GitInterfaces'
import { IPullRequestInfo, IPullRequestMetadata } from './models/pullRequestInterfaces'
import { singleton } from 'tsyringe'
import { Validator } from './utilities/validator'
import AzureReposInvoker from './invokers/azureReposInvoker'
import CodeMetrics from './updaters/codeMetrics'
import CodeMetricsData from './updaters/codeMetricsData'
import PullRequest from './updaters/pullRequest'
import PullRequestComments from './updaters/pullRequestComments'
import PullRequestCommentsData from './updaters/pullRequestCommentsData'
import TaskLibWrapper from './wrappers/taskLibWrapper'

/**
 * A class for calculating and updating the code metrics within pull requests.
 */
@singleton()
export default class CodeMetricsCalculator {
  private _azureReposInvoker: AzureReposInvoker
  private _codeMetrics: CodeMetrics
  private _pullRequest: PullRequest
  private _pullRequestComments: PullRequestComments
  private _taskLibWrapper: TaskLibWrapper

  /**
   * Initializes a new instance of the `CodeMetricsCalculator` class.
   * @param azureReposInvoker The Azure Repos invoker logic.
   * @param codeMetrics The code metrics calculation logic.
   * @param pullRequest The pull request modification logic.
   * @param pullRequestComments The pull request comments modification logic.
   * @param taskLibWrapper The wrapper around the Azure Pipelines Task Lib.
   */
  public constructor (azureReposInvoker: AzureReposInvoker, codeMetrics: CodeMetrics, pullRequest: PullRequest, pullRequestComments: PullRequestComments, taskLibWrapper: TaskLibWrapper) {
    this._azureReposInvoker = azureReposInvoker
    this._codeMetrics = codeMetrics
    this._pullRequest = pullRequest
    this._pullRequestComments = pullRequestComments
    this._taskLibWrapper = taskLibWrapper
  }

  /**
   * Gets a message indicating whether the task can be run.
   * @returns `null` if the task can be run, or a message to display if the task cannot be run.
   */
  public get shouldSkip (): string | null {
    this._taskLibWrapper.debug('* CodeMetricsCalculator.shouldSkip')

    if (!this._pullRequest.isPullRequest) {
      return this._taskLibWrapper.loc('codeMetricsCalculator.noPullRequest')
    }

    return null
  }

  /**
   * Gets a message indicating whether the task can be run.
   * @returns `null` if the task can be run, or a message to display if the task cannot be run.
   */
  public get shouldTerminate (): string | null {
    this._taskLibWrapper.debug('* CodeMetricsCalculator.shouldTerminate')

    if (!this._azureReposInvoker.isAccessTokenAvailable) {
      return this._taskLibWrapper.loc('codeMetricsCalculator.noAccessToken')
    }

    return null
  }

  /**
   * Updates the pull request details.
   * @returns A promise for await the completion of the method call.
   */
  public async updateDetails (): Promise<void> {
    this._taskLibWrapper.debug('* CodeMetricsCalculator.updateDetails()')

    const details: IPullRequestInfo = await this._azureReposInvoker.getTitleAndDescription()
    const updatedTitle: string | null = this._pullRequest.getUpdatedTitle(details.title)
    const updatedDescription: string | null = this._pullRequest.getUpdatedDescription(details.description)

    await this._azureReposInvoker.setTitleAndDescription(updatedTitle, updatedDescription)
  }

  /**
   * Updates the pull request comments.
   * @returns A promise for await the completion of the method call.
   */
  public async updateComments (): Promise<void> {
    this._taskLibWrapper.debug('* CodeMetricsCalculator.updateComments()')

    const promises: Promise<void>[] = []

    const currentIteration: number = await this._azureReposInvoker.getCurrentIteration()
    const commentData: PullRequestCommentsData = await this._pullRequestComments.getCommentData(currentIteration)
    if (!commentData.isMetricsCommentPresent) {
      promises.push(this.updateMetricsComment(commentData, currentIteration))
      promises.push(this.addMetadata())
    }

    commentData.ignoredFilesWithLinesAdded.forEach((fileName: string): void => {
      promises.push(this.updateIgnoredComment(fileName, true))
    })

    commentData.ignoredFilesWithoutLinesAdded.forEach((fileName: string): void => {
      promises.push(this.updateIgnoredComment(fileName, false))
    })

    await Promise.all(promises)
  }

  private async updateMetricsComment (commentData: PullRequestCommentsData, currentIteration: number): Promise<void> {
    this._taskLibWrapper.debug('* CodeMetricsCalculator.updateMetricsComment()')

    const comment: string = this._pullRequestComments.getMetricsComment(currentIteration)
    if (commentData.metricsCommentThreadId !== null) {
      await this._azureReposInvoker.createComment(comment, commentData.metricsCommentThreadId, commentData.metricsCommentId!)
    } else {
      const commentThread: GitPullRequestCommentThread = await this._azureReposInvoker.createCommentThread(comment, null, true)
      commentData.metricsCommentThreadId = Validator.validateField(commentThread.id, 'id', 'CodeMetricsCalculator.updateMetricsComment()')
    }

    const status: CommentThreadStatus = this._pullRequestComments.getMetricsCommentStatus()
    await this._azureReposInvoker.setCommentThreadStatus(commentData.metricsCommentThreadId, status)
  }

  private async addMetadata (): Promise<void> {
    this._taskLibWrapper.debug('* CodeMetricsCalculator.addMetadata()')

    const metrics: CodeMetricsData = this._codeMetrics.metrics
    const metadata: IPullRequestMetadata[] = [
      {
        key: '/PRMetrics.Size',
        value: this._codeMetrics.size
      },
      {
        key: '/PRMetrics.ProductCode',
        value: metrics.productCode
      },
      {
        key: '/PRMetrics.TestCode',
        value: metrics.testCode
      },
      {
        key: '/PRMetrics.Subtotal',
        value: metrics.subtotal
      },
      {
        key: '/PRMetrics.IgnoredCode',
        value: metrics.ignoredCode
      },
      {
        key: '/PRMetrics.Total',
        value: metrics.total
      }
    ]

    if (this._codeMetrics.isSufficientlyTested !== null) {
      metadata.push({
        key: '/PRMetrics.TestCoverage',
        value: this._codeMetrics.isSufficientlyTested
      })
    }

    await this._azureReposInvoker.addMetadata(metadata)
  }

  private async updateIgnoredComment (fileName: string, withLinesAdded: boolean): Promise<void> {
    this._taskLibWrapper.debug('* CodeMetricsCalculator.updateIgnoredComment()')

    const ignoredComment: string = this._pullRequestComments.ignoredComment
    const commentThread: GitPullRequestCommentThread = await this._azureReposInvoker.createCommentThread(ignoredComment, fileName, withLinesAdded)

    const commentThreadId: number = Validator.validateField(commentThread.id, 'id', 'CodeMetricsCalculator.updateIgnoredComment()')
    await this._azureReposInvoker.setCommentThreadStatus(commentThreadId, CommentThreadStatus.Closed)
  }
}
