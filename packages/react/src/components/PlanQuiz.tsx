'use client';

/**
 * PlanQuiz Component (ChooseBestPlan)
 * Interactive quiz with dynamic questions generated from plan features
 */

import { useState, useMemo } from 'react';
import { useMarginFrontContext } from '../context';
import { cn } from '../utils/cn';
import type { PricingPlanV2, BusinessContext } from '../types/pricing';

export interface PlanQuizProps {
  /** The plans to compare. */
  pricingPlans: PricingPlanV2[];
  /** Company name for display */
  companyName?: string;
  /** Brand color (hex) - overrides theme */
  brandColor?: string;
  /** Business context for dynamic UI customization */
  businessContext?: BusinessContext;
  /** Custom class name */
  className?: string;
  /** Callback when plan is selected */
  onSelectPlan?: (plan: PricingPlanV2) => void;
  /** Callback when quiz is completed */
  onComplete?: (recommendedPlan: PricingPlanV2) => void;
}

interface QuizQuestion {
  id: number;
  question: string;
  options: { label: string; planIndex: number }[];
}

// Extract usage/limit info from plan features
const extractUsageLimits = (plans: PricingPlanV2[]): { type: string; limits: string[] } => {
  const patterns = [
    { regex: /(\d+[kK]?\+?)\s*(credits?|tokens?)/i, type: 'credits' },
    { regex: /(\d+[kK]?\+?)\s*(requests?|calls?|api)/i, type: 'requests' },
    { regex: /(\d+[kK]?\+?)\s*(users?|seats?|members?)/i, type: 'users' },
    { regex: /(\d+[kK]?\+?)\s*(projects?|workspaces?)/i, type: 'projects' },
    { regex: /unlimited/i, type: 'unlimited' },
  ];

  const typeCounts: Record<string, number> = {};

  plans.forEach((plan) => {
    plan.features.forEach((feature) => {
      for (const { regex, type } of patterns) {
        if (feature.match(regex)) {
          typeCounts[type] = (typeCounts[type] || 0) + 1;
          break;
        }
      }
    });
  });

  let mainType = 'usage';
  let maxCount = 0;
  Object.entries(typeCounts).forEach(([type, count]) => {
    if (count > maxCount) {
      maxCount = count;
      mainType = type;
    }
  });

  const limits = plans.map((plan) => {
    const numericFeature = plan.features.find((f) => /\d+[kK]?/.test(f));
    if (numericFeature) return numericFeature;
    if (plan.price === 0) return `${plan.name} (Free tier)`;
    return `${plan.name} plan`;
  });

  return { type: mainType, limits };
};

// Generate dynamic questions from plan data
const generateDynamicQuestions = (plans: PricingPlanV2[]): QuizQuestion[] => {
  if (plans.length === 0) return [];

  const { limits } = extractUsageLimits(plans);
  const planCount = plans.length;

  // Question 1: Based on plan limits
  const question1Options = plans.map((plan, idx) => ({
    label: limits[idx] || plan.name,
    planIndex: idx,
  })).slice(0, 4);

  // Question 2: Team size
  const teamSizeOptions = [
    { label: 'Just me', planIndex: 0 },
    { label: 'Small team (2-10)', planIndex: Math.min(1, planCount - 1) },
    { label: 'Growing team (10-50)', planIndex: Math.min(2, planCount - 1) },
    { label: 'Large organization (50+)', planIndex: planCount - 1 },
  ].slice(0, Math.max(2, planCount));

  // Question 3: Feature preferences
  const featureOptions = plans.map((plan, idx) => {
    const distinctiveFeature = plan.features.find((f) =>
      /advanced|priority|custom|unlimited|enterprise/i.test(f)
    ) || plan.features[0] || plan.name;

    return {
      label: distinctiveFeature.length > 30 ? distinctiveFeature.substring(0, 27) + '...' : distinctiveFeature,
      planIndex: idx,
    };
  }).slice(0, 4);

  const questions: QuizQuestion[] = [];

  questions.push({
    id: 1,
    question: 'What level of usage do you expect?',
    options: question1Options,
  });

  questions.push({
    id: 2,
    question: "What's your team size?",
    options: teamSizeOptions,
  });

  if (featureOptions.length >= 2) {
    questions.push({
      id: 3,
      question: 'Which features matter most to you?',
      options: featureOptions,
    });
  }

  return questions;
};

export function PlanQuiz({
  pricingPlans: allPlans,
  companyName: _companyName = 'Your Product',
  brandColor,
  businessContext: _businessContext,
  className,
  onSelectPlan,
  onComplete,
}: PlanQuizProps) {
  const { theme } = useMarginFrontContext();
  const primaryColor = brandColor || theme.primary || '#047857';

  // Filter and sort plans
  const plans = useMemo(
    () => allPlans.filter((p) => p.enabled).sort((a, b) => a.price - b.price).slice(0, 4),
    [allPlans]
  );

  const questions = useMemo(() => generateDynamicQuestions(plans), [plans]);

  const [currentQuestion, setCurrentQuestion] = useState(0);
  const [answers, setAnswers] = useState<number[]>([]);
  const [showResult, setShowResult] = useState(false);

  const handleAnswer = (planIndex: number) => {
    const newAnswers = [...answers, planIndex];
    setAnswers(newAnswers);

    if (currentQuestion < questions.length - 1) {
      setCurrentQuestion(currentQuestion + 1);
    } else {
      setShowResult(true);
    }
  };

  const getRecommendedPlan = () => {
    if (answers.length === 0 || plans.length === 0) return plans[0];

    const counts: Record<number, number> = {};
    answers.forEach((idx) => {
      counts[idx] = (counts[idx] || 0) + 1;
    });

    let maxCount = 0;
    let recommendedIdx = 0;
    Object.entries(counts).forEach(([idx, count]) => {
      if (count > maxCount) {
        maxCount = count;
        recommendedIdx = Number(idx);
      }
    });

    return plans[recommendedIdx] || plans[0];
  };

  const resetQuiz = () => {
    setCurrentQuestion(0);
    setAnswers([]);
    setShowResult(false);
  };


  if (plans.length === 0 || questions.length === 0) {
    return (
      <div className={cn('marginfront-plan-quiz', className)}>
        <div className="bg-white border border-gray-200 rounded-2xl p-8 text-center text-gray-500">
          No pricing plans available
        </div>
      </div>
    );
  }

  const recommendedPlan = getRecommendedPlan();

  // Trigger onComplete when showing result
  if (showResult && onComplete && recommendedPlan) {
    setTimeout(() => onComplete(recommendedPlan), 0);
  }

  return (
    <div className={cn('marginfront-plan-quiz', className)}>
      <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden">
        <div className="p-8">
          {/* Header */}
          <div className="text-center mb-8">
            <h3 className="text-xl font-bold text-gray-900 mb-2">Choose the best plan for you</h3>
            <p className="text-sm text-gray-500">
              Answer a few quick questions and we&apos;ll recommend the perfect plan
            </p>
          </div>

          {!showResult ? (
            <div className="bg-gray-50 rounded-xl p-5">
              {/* Progress Bar */}
              <div className="flex gap-1.5 mb-6">
                {questions.map((_, index) => (
                  <div
                    key={index}
                    className="h-1.5 flex-1 rounded-full transition-colors"
                    style={{ backgroundColor: index <= currentQuestion ? primaryColor : '#e5e7eb' }}
                  />
                ))}
              </div>

              {/* Question */}
              <div className="text-center mb-5">
                <span className="text-[11px] font-semibold mb-2 block" style={{ color: primaryColor }}>
                  Question {currentQuestion + 1} of {questions.length}
                </span>
                <h4 className="text-base font-bold text-gray-900">{questions[currentQuestion].question}</h4>
              </div>

              {/* Options */}
              <div className="grid grid-cols-2 gap-2">
                {questions[currentQuestion].options.map((option, index) => (
                  <button
                    key={index}
                    onClick={() => handleAnswer(option.planIndex)}
                    className="p-3 border-2 rounded-lg text-left transition-all bg-white border-gray-200 hover:border-gray-400"
                  >
                    <span className="text-sm font-medium text-gray-900">{option.label}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            /* Result */
            <div className="bg-gray-900 rounded-xl p-6 text-center">
              {/* Success Icon */}
              <div
                className="inline-flex items-center justify-center w-12 h-12 rounded-full mb-4"
                style={{ backgroundColor: primaryColor }}
              >
                <svg className="w-6 h-6 text-white" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                </svg>
              </div>

              <h4 className="text-lg font-bold text-white mb-1">
                We recommend the {recommendedPlan.name} plan
              </h4>
              <p className="text-white/60 text-xs mb-5">
                {recommendedPlan.features[0] || `${recommendedPlan.name} - $${recommendedPlan.price}/mo`}
              </p>

              {/* Plan Card */}
              <div className="bg-white rounded-xl p-4 text-left mx-auto max-w-xs">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-[10px] uppercase tracking-wider font-medium text-gray-500">
                    {recommendedPlan.name}
                  </span>
                  <span className="text-[11px] font-semibold" style={{ color: primaryColor }}>
                    {recommendedPlan.features.length} features
                  </span>
                </div>

                <div className="text-2xl font-bold text-gray-900 mb-3">
                  {recommendedPlan.price === 0 ? 'Contact Sales' : `$${recommendedPlan.price}`}
                  {recommendedPlan.price > 0 && (
                    <span className="text-sm font-normal text-gray-400">
                      /{recommendedPlan.billingCycle === 'yearly' ? 'year' : 'month'}
                    </span>
                  )}
                </div>

                <ul className="space-y-1.5">
                  {recommendedPlan.features.slice(0, 3).map((feature, index) => (
                    <li key={index} className="flex items-center gap-2">
                      <svg className="w-3.5 h-3.5" style={{ color: primaryColor }} fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                      </svg>
                      <span className="text-xs text-gray-600">{feature}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* Actions */}
              <div className="flex gap-3 justify-center mt-5">
                <button
                  onClick={() => onSelectPlan?.(recommendedPlan)}
                  className="px-5 py-2 rounded-lg text-xs font-semibold transition-opacity hover:opacity-90 text-white"
                  style={{ backgroundColor: primaryColor }}
                >
                  Choose this plan
                </button>
                <button
                  onClick={resetQuiz}
                  className="px-5 py-2 rounded-lg text-xs font-semibold border transition-colors flex items-center gap-1.5 border-white/20 text-white hover:bg-white/10"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  Retake quiz
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// The same component under its second public name.
export { PlanQuiz as ChooseBestPlan };
