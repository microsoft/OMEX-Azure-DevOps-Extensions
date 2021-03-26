// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { CommentThreadStatus } from 'azure-devops-node-api/interfaces/GitInterfaces'
import { singleton } from 'tsyringe'
import AzureReposInvoker from './invokers/azureReposInvoker'
import CodeMetrics from './updaters/codeMetrics'
import CodeMetricsData from './updaters/codeMetricsData'
import IPullRequestDetails from './invokers/iPullRequestDetails'
import IPullRequestMetadata from './invokers/iPullRequestMetadata'
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
   * @returns A promise for awaiting the completion of the method call.
   */
  public async updateDetails (): Promise<void> {
    this._taskLibWrapper.debug('* CodeMetricsCalculator.updateDetails()')

    const details: IPullRequestDetails = await this._azureReposInvoker.getTitleAndDescription()
    const updatedTitle: string | null = this._pullRequest.getUpdatedTitle(details.title)
    const updatedDescription: string | null = this._pullRequest.getUpdatedDescription(details.description)

    await this._azureReposInvoker.setTitleAndDescription(updatedTitle, updatedDescription)
  }

  /**
   * Updates the pull request comments.
   * @returns A promise for awaiting the completion of the method call.
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
    const status: CommentThreadStatus = this._pullRequestComments.getMetricsCommentStatus()
    if (commentData.metricsCommentThreadId !== null) {
      await this._azureReposInvoker.createComment(comment, commentData.metricsCommentThreadId, commentData.metricsCommentId!)
      await this._azureReposInvoker.setCommentThreadStatus(commentData.metricsCommentThreadId, status)
    } else {
      await this._azureReposInvoker.createCommentThread(comment, status)
    }
  }

  private async addMetadata (): Promise<void> {
    this._taskLibWrapper.debug('* CodeMetricsCalculator.addMetadata()')

    const metrics: CodeMetricsData = this._codeMetrics.metrics
    const metadata: IPullRequestMetadata[] = [
      {
        key: 'Size',
        value: this._codeMetrics.size
      },
      {
        key: 'ProductCode',
        value: metrics.productCode
      },
      {
        key: 'TestCode',
        value: metrics.testCode
      },
      {
        key: 'Subtotal',
        value: metrics.subtotal
      },
      {
        key: 'IgnoredCode',
        value: metrics.ignoredCode
      },
      {
        key: 'Total',
        value: metrics.total
      }
    ]

    if (this._codeMetrics.isSufficientlyTested !== null) {
      metadata.push({
        key: 'TestCoverage',
        value: this._codeMetrics.isSufficientlyTested
      })
    }

    await this._azureReposInvoker.addMetadata(metadata)
  }

  private async updateIgnoredComment (fileName: string, withLinesAdded: boolean): Promise<void> {
    this._taskLibWrapper.debug('* CodeMetricsCalculator.updateIgnoredComment()')

    const ignoredComment: string = this._pullRequestComments.ignoredComment
    await this._azureReposInvoker.createCommentThread(ignoredComment, CommentThreadStatus.Closed, fileName, withLinesAdded)
  }
}
